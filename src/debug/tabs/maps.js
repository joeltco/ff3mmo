// MAPS tab — view any map the way the renderer builds it.
//
// Two views, because they answer different questions:
//   FULL   — the whole 32x32 tilemap, with the room clip drawn on top. Shows
//            what the tilemap CONTAINS and how much of it we paint.
//   PLAYER — the 144x144 window the player actually looks at (9x9 tiles), same
//            camera math as render.js. Reviewing the full tilemap and calling a
//            room "fine" is how four bad room-clip changes shipped; the player
//            never sees that picture.
//
// SEED matters as much as the map id. `MapRenderer` computes the room clip ONCE
// from the tile it is constructed on, and `map-loading.js` hands it the RETURN
// position when you come back through a door — so the same map has a different
// clip depending on how you entered. The Kazus inn drew a neighbouring room's
// staircase above its ceiling on re-entry only. The seed dropdown lists the
// spawn and every door so that case is one click away.
//
// Everything here is pure: loadMap() and MapRenderer take ROM bytes and produce
// their own canvas. The tab therefore does NOT touch the game's live map state,
// which matters because debug tabs import a SECOND copy of every module (no
// `?_v=` cache-bust) and singleton state from the game's copy is not visible.

import { loadMap } from '../../map-loader.js';
import { MapRenderer } from '../../map-renderer.js';
import { applyIPS } from '../../ips-patcher.js';

const MAP_SIZE = 32;
const TILE = 16;
const MAP_PX = MAP_SIZE * TILE;          // 512
// Mirrors src/render.js
const HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const SCREEN_CENTER_X = (HUD_VIEW_W - 16) / 2;
const SCREEN_CENTER_Y = (HUD_VIEW_H - 16) / 2 - 3;

let dom = null;
let activeMount = null;
let state = {
  id: 12, view: 'full', seed: 'spawn', cam: null,
  showClip: true, showGrid: false, showDoors: true,
};
let cache = { id: -1, seedKey: '', md: null, renderer: null };

const S = {
  btn: 'background:#1a1a28;color:#c8a832;border:1px solid #444;border-radius:3px;' +
       'font-family:monospace;font-size:11px;padding:3px 8px;cursor:pointer;',
  btnOn: 'background:#c8a832;color:#111;border:1px solid #c8a832;border-radius:3px;' +
         'font-family:monospace;font-size:11px;padding:3px 8px;cursor:pointer;',
  input: 'background:#0e0e1a;color:#c8a832;border:1px solid #444;border-radius:3px;' +
         'font-family:monospace;font-size:11px;padding:3px 6px;width:56px;',
  label: 'color:#888;font-family:monospace;font-size:10px;',
};

// Mirrors src/map-loading.js#_calcSpawnY — the ROM entrance is the door on the
// OUTSIDE of a building; the game walks the player to the interior doorway.
function calcSpawnY(m, ex, ey) {
  const at = (x, y) => m.tilemap[y * MAP_SIZE + x];
  const collOf = (mid) => m.collision[mid < 128 ? mid : mid & 0x7F];
  if ((collOf(at(ex, ey)) & 0x07) === 3) {
    for (let d = 1; d < 32; d++) { const ny = (ey - d + 32) % 32; if (at(ex, ny) === 0x44) return ny; }
    for (let d = 1; d <= 16; d++) {
      const ny = ey + d; if (ny >= 32) break;
      const mid = at(ex, ny); if (mid === m.fillTile) break;
      const c = collOf(mid); if ((c & 0x07) !== 3 && !(c & 0x80)) return ny;
    }
    for (let d = 1; d <= 16; d++) {
      const ny = ey - d; if (ny < 0) break;
      const mid = at(ex, ny); if (mid === m.fillTile) break;
      const c = collOf(mid); if ((c & 0x07) !== 3 && !(c & 0x80)) return ny;
    }
    return ey;
  }
  const entMid = at(ex, ey);
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  if (entMid === 0x44) return ey;
  if ((m.collision[entM] & 0x80) && ((m.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let d = 1; d <= 8; d++) { const ny = ey - d; if (ny < 0) break; if (at(ex, ny) === 0x44) return ny; }
  }
  return ey;
}

function doorsOf(md) {
  const out = [];
  if (!md.triggerMap) return out;
  for (const [key, t] of md.triggerMap) {
    if (t.type !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    const dest = md.entranceData ? (md.entranceData[t.trigId] | 0) : 0;
    out.push({ x, y, dest });
  }
  return out;
}

function build(rom) {
  const seedKey = state.seed;
  if (cache.id === state.id && cache.seedKey === seedKey && cache.renderer) return cache;

  const md = loadMap(rom, state.id);
  // Mirror the game's load-time passage opening (v1.7.950).
  if (md.tilemap[16 * MAP_SIZE + 8] !== 0x32) {
    for (let i = 0; i < md.tilemap.length; i++) {
      if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
      if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
    }
  }
  const spawn = { x: md.entranceX, y: calcSpawnY(md, md.entranceX, md.entranceY) };
  let sx = spawn.x, sy = spawn.y;
  if (seedKey !== 'spawn') {
    const [dx, dy] = seedKey.split(',').map(Number);
    sx = dx; sy = dy;
  }
  const renderer = new MapRenderer(md, sx, sy);
  cache = { id: state.id, seedKey, md, renderer, spawn, seedTile: { x: sx, y: sy } };
  if (!state.cam) state.cam = { x: sx, y: sy };
  return cache;
}

function draw(rom) {
  let c;
  try { c = build(rom); } catch (e) {
    dom.info.textContent = `map ${state.id}: failed to load — ${e.message}`;
    dom.ctx.fillStyle = '#000';
    dom.ctx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);
    return;
  }
  const { md, renderer, spawn, seedTile } = c;
  const g = dom.ctx;

  if (state.view === 'full') {
    dom.canvas.width = MAP_PX; dom.canvas.height = MAP_PX;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000';
    g.fillRect(0, 0, MAP_PX, MAP_PX);
    // The prerendered map is exactly what draw() blits, so this is our output,
    // not a re-implementation of it.
    if (renderer._mapCanvas) g.drawImage(renderer._mapCanvas, 0, 0);

    if (state.showGrid) {
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
      for (let i = 0; i <= MAP_SIZE; i++) {
        g.beginPath(); g.moveTo(i * TILE + 0.5, 0); g.lineTo(i * TILE + 0.5, MAP_PX); g.stroke();
        g.beginPath(); g.moveTo(0, i * TILE + 0.5); g.lineTo(MAP_PX, i * TILE + 0.5); g.stroke();
      }
    }
    if (state.showClip) {
      const clip = renderer.getRoomClip?.();
      if (clip) {
        g.strokeStyle = '#c8a832'; g.lineWidth = 2;
        g.strokeRect(clip.x + 1, clip.y + 1, clip.w - 2, clip.h - 2);
      }
    }
    if (state.showDoors) {
      g.strokeStyle = '#4af'; g.lineWidth = 2;
      for (const d of doorsOf(md)) g.strokeRect(d.x * TILE + 1, d.y * TILE + 1, TILE - 2, TILE - 2);
    }
    // spawn (green) and the seed the clip was built from (magenta)
    g.strokeStyle = '#4f4'; g.lineWidth = 2;
    g.strokeRect(spawn.x * TILE + 1, spawn.y * TILE + 1, TILE - 2, TILE - 2);
    if (seedTile.x !== spawn.x || seedTile.y !== spawn.y) {
      g.strokeStyle = '#f4f'; g.lineWidth = 2;
      g.strokeRect(seedTile.x * TILE + 1, seedTile.y * TILE + 1, TILE - 2, TILE - 2);
    }
    // camera marker
    if (state.cam) {
      g.strokeStyle = '#fff'; g.lineWidth = 1;
      g.strokeRect(state.cam.x * TILE - 63.5, state.cam.y * TILE - 63.5, HUD_VIEW_W, HUD_VIEW_H);
    }
  } else {
    dom.canvas.width = HUD_VIEW_W; dom.canvas.height = HUD_VIEW_H;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000';
    g.fillRect(0, 0, HUD_VIEW_W, HUD_VIEW_H);
    const cam = state.cam || seedTile;
    renderer.draw(g, cam.x * TILE, cam.y * TILE, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3);
    renderer.drawOverlay?.(g, cam.x * TILE, cam.y * TILE, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3,
                           SCREEN_CENTER_X, SCREEN_CENTER_Y);
    g.strokeStyle = '#f0f'; g.lineWidth = 1;
    g.strokeRect(SCREEN_CENTER_X + 0.5, SCREEN_CENTER_Y + 0.5, 15, 15);
  }

  const clip = renderer.getRoomClip?.();
  const d = renderer._clipDiag || {};
  const cam = state.cam || seedTile;
  dom.info.innerHTML =
    `<b style="color:#c8a832">map ${state.id}</b>  tileset ${md.tileset}  fill $${md.fillTile.toString(16)}` +
    `  &nbsp; entrance (${md.entranceX},${md.entranceY}) → <span style="color:#4f4">spawn (${spawn.x},${spawn.y})</span>` +
    `  &nbsp; seed <span style="color:#f4f">(${seedTile.x},${seedTile.y})</span>` +
    `  &nbsp; camera (${cam.x},${cam.y})<br>` +
    (clip
      ? `<span style="color:#c8a832">clip</span> x ${clip.x / TILE}..${(clip.x + clip.w) / TILE - 1}` +
        ` y ${clip.y / TILE}..${(clip.y + clip.h) / TILE - 1}`
      : `<span style="color:#c8a832">clip</span> none (whole map drawn)`) +
    (d.rminY !== undefined
      ? `  &nbsp; room y ${d.rminY}..${d.rmaxY}  x ${d.rminX}..${d.rmaxX}` +
        `  &nbsp; ${d.roomSize} walkable (${(d.roomFraction ?? 0).toFixed(2)} of map)` +
        `  &nbsp; enclosed ${d.isEnclosedRoom ? 'YES' : 'no'}`
      : '') +
    `  &nbsp; doors ${doorsOf(md).map(x => `(${x.x},${x.y})→${x.dest}`).join(' ') || 'none'}`;

  // Rebuild the seed picker when the map changes.
  const want = ['spawn', ...doorsOf(md).map(x => `${x.x},${x.y}`)].join('|');
  if (dom.seedSel.dataset.want !== want) {
    dom.seedSel.dataset.want = want;
    dom.seedSel.innerHTML = '';
    const addOpt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; dom.seedSel.appendChild(o); };
    addOpt('spawn', `spawn (${spawn.x},${spawn.y})`);
    for (const dr of doorsOf(md)) addOpt(`${dr.x},${dr.y}`, `door (${dr.x},${dr.y}) → map ${dr.dest}`);
    dom.seedSel.value = state.seed;
    if (dom.seedSel.selectedIndex < 0) { dom.seedSel.value = 'spawn'; state.seed = 'spawn'; }
  }
}

// `ctx.getFF3Buffer()` hands back the raw **ArrayBuffer** the file/zip loader
// produced — `main.js#loadROM` is what wraps it in a Uint8Array. Passing the
// ArrayBuffer straight to `loadMap` indexes it like a byte array, every read
// comes back undefined, and the map parses into nothing ("md.fillTile is
// undefined"). It also arrives UNPATCHED: the game applies patches/ff3-awj.ips
// during boot, so reading maps without it shows different bytes than the ones
// the player is walking around in.
async function romBytesFor(ctx) {
  const raw = ctx?.getFF3Buffer?.();
  if (!raw) return null;
  const bytes = new Uint8Array(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  try {
    const resp = await fetch('patches/ff3-awj.ips');
    // IPS is overwrite-only, so re-applying to an already-patched buffer is a no-op.
    if (resp && resp.ok) applyIPS(bytes, new Uint8Array(await resp.arrayBuffer()));
  } catch (e) {
    console.warn('[maps] IPS fetch failed, showing the raw ROM', e);
  }
  return bytes;
}

export function mount(root, ctx) {
  const rom = ctx?.getFF3Buffer?.();
  if (!rom) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:16px;color:#a66;font-size:12px;font-family:monospace;';
    msg.textContent = 'No FF3 ROM loaded — load it on the title screen first.';
    root.appendChild(msg);
    return;
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:10px;font-family:monospace;';

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px;';

  const mk = (tag, css, txt) => { const e = document.createElement(tag); e.style.cssText = css; if (txt != null) e.textContent = txt; return e; };

  const prev = mk('button', S.btn, '◀');
  const idIn = mk('input', S.input); idIn.type = 'number'; idIn.min = '0'; idIn.max = '255'; idIn.value = String(state.id);
  const next = mk('button', S.btn, '▶');
  const viewFull = mk('button', S.btn, 'FULL MAP');
  const viewPlayer = mk('button', S.btn, 'PLAYER VIEW');
  const seedSel = mk('select', S.input.replace('width:56px;', 'width:auto;'));
  const clipBtn = mk('button', S.btn, 'CLIP');
  const gridBtn = mk('button', S.btn, 'GRID');
  const doorBtn = mk('button', S.btn, 'DOORS');
  const zoomOut = mk('button', S.btn, '−');
  const zoomIn = mk('button', S.btn, '+');

  bar.append(mk('span', S.label, 'MAP'), prev, idIn, next,
    mk('span', S.label, '  VIEW'), viewFull, viewPlayer,
    mk('span', S.label, '  SEED'), seedSel,
    mk('span', S.label, '  SHOW'), clipBtn, gridBtn, doorBtn,
    mk('span', S.label, '  ZOOM'), zoomOut, zoomIn);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'background:#000;border:1px solid #333;image-rendering:pixelated;display:block;cursor:crosshair;';

  const info = mk('div', 'color:#888;font-size:10px;line-height:1.7;margin-top:8px;');
  const hint = mk('div', 'color:#555;font-size:10px;margin-top:6px;',
    'Click the full map to move the camera, then switch to PLAYER VIEW to see it as the player does. ' +
    'Gold = room clip, green = spawn, magenta = clip seed, blue = doors, white = 9x9 window.');

  wrap.append(bar, canvas, info, hint);
  root.appendChild(wrap);

  let zoom = 2;
  let romBytes = null;
  const mountToken = {};
  activeMount = mountToken;
  dom = { canvas, ctx: canvas.getContext('2d'), info, seedSel };

  const applyZoom = () => {
    const w = state.view === 'full' ? MAP_PX : HUD_VIEW_W;
    const h = state.view === 'full' ? MAP_PX : HUD_VIEW_H;
    canvas.style.width = (w * zoom) + 'px';
    canvas.style.height = (h * zoom) + 'px';
  };
  const refresh = () => {
    viewFull.style.cssText = state.view === 'full' ? S.btnOn : S.btn;
    viewPlayer.style.cssText = state.view === 'player' ? S.btnOn : S.btn;
    clipBtn.style.cssText = state.showClip ? S.btnOn : S.btn;
    gridBtn.style.cssText = state.showGrid ? S.btnOn : S.btn;
    doorBtn.style.cssText = state.showDoors ? S.btnOn : S.btn;
    if (romBytes) draw(romBytes);
    applyZoom();
  };
  const setId = (v) => {
    state.id = Math.max(0, Math.min(255, v | 0));
    idIn.value = String(state.id);
    state.seed = 'spawn'; state.cam = null; seedSel.dataset.want = '';
    refresh();
  };

  prev.onclick = () => setId(state.id - 1);
  next.onclick = () => setId(state.id + 1);
  idIn.onchange = () => setId(parseInt(idIn.value, 10) || 0);
  viewFull.onclick = () => { state.view = 'full'; refresh(); };
  viewPlayer.onclick = () => { state.view = 'player'; refresh(); };
  seedSel.onchange = () => { state.seed = seedSel.value; state.cam = null; refresh(); };
  clipBtn.onclick = () => { state.showClip = !state.showClip; refresh(); };
  gridBtn.onclick = () => { state.showGrid = !state.showGrid; refresh(); };
  doorBtn.onclick = () => { state.showDoors = !state.showDoors; refresh(); };
  zoomIn.onclick = () => { zoom = Math.min(6, zoom + 1); applyZoom(); };
  zoomOut.onclick = () => { zoom = Math.max(1, zoom - 1); applyZoom(); };
  canvas.onclick = (e) => {
    if (state.view !== 'full') return;
    const r = canvas.getBoundingClientRect();
    state.cam = {
      x: Math.floor((e.clientX - r.left) / r.width * MAP_SIZE),
      y: Math.floor((e.clientY - r.top) / r.height * MAP_SIZE),
    };
    refresh();
  };

  info.textContent = 'loading ROM…';
  applyZoom();
  romBytesFor(ctx).then((bytes) => {
    // The tab can be swapped away while the IPS fetch is in flight; drawing
    // then would write into a detached canvas and clobber the next tab's state.
    if (activeMount !== mountToken) return;
    romBytes = bytes;
    refresh();
  }).catch((e) => {
    if (activeMount !== mountToken) return;
    info.textContent = 'failed to read the ROM: ' + e.message;
  });
}

export function unmount() {
  activeMount = null;
  dom = null;
  cache = { id: -1, seedKey: '', md: null, renderer: null };
}
