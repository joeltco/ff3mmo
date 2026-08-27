// DUNGEON tab — look at what the generator actually produces, on a phone.
//
// `tools/floor-view.mjs` and `floor-png.mjs` answer this at a terminal, which is
// no use while you are playing. This shows the same thing in the panel: the
// floor as the game paints it, the PLAN behind it (topology, chambers, links),
// and the things a picture cannot tell you — what is reachable, where the
// secrets are, and what each exit is wired to.
//
// ⛔ PURE. `generateFloor` takes ROM bytes and a seed and returns a fresh map;
// it touches no live game state. That matters because debug tabs import a SECOND
// copy of every module (no `?_v=` cache-bust), so anything depending on the
// game's singletons would silently read a blank instance. The only thing needed
// from the game is the ROM buffer, via `ctx.getFF3Buffer()`.
//
// ⛔ PHONE FIRST. Controls are ≥40px tall, the layout is one column, the canvas
// scales to the viewport width, and everything below it scrolls. Nothing here
// depends on hover.

import { DUNGEONS, layoutForFloor, corridorBounds } from '../../data/dungeons.js';
import { generateFloor } from '../../dungeon-generator.js';
import { parseMapProperties, loadTileset, loadCHRGraphics, buildMapPalettes, loadNameTable } from '../../map-loader.js';
import { describePlan } from '../../dungeon/plan.js';
import { applyIPS } from '../../ips-patcher.js';
import { NES_SYSTEM_PALETTE } from '../../tile-decoder.js';

const W = 32, TILE = 16, PX = W * TILE;   // 512
// Mirrors dungeon-sweep.mjs's PASS — deliberately stricter than the game's
// `isPassable`, so anything it calls unreachable is worth a second look rather
// than being certainly broken.
const PASS = new Set([0x30, 0x09, 0x41, 0x49, 0x44, 0x73, 0x42, 0x68, 0x6a, 0x60]);
const CHEST = 0x7c, BONES = 0x09, FALSE_CEILING = 0x44;

// ⛔ THIS PREVIEWED A REPAINT, NOT A DUNGEON.
//
// `previewDungeon` used to be `{ ...STARTING_DUNGEON, donorMap, bossSkinId }` —
// it spread ALTAR CAVE and swapped only the art. So pressing SEALS showed Altar
// Cave's floors in the Seals' palette: its `layout.floors`, its corridor
// lengths, its snake ranges and its chamber weights never reached the preview at
// all, and none of the last week's work was visible here.
//
// Joel, 2026-08-21: "lets make a dungeon generator preview in the konami debug.
// i want to be abke to see everything." Everything means the real rows.
//
// The dungeon buttons ARE `DUNGEONS` now. Floor count, floor labels and every
// carve come from the row, so this shows what the game generates rather than a
// preview of something adjacent to it.
const CAVES = DUNGEONS;

// ⛔ ONE SHORT LABEL PER LAYOUT, AND THEY MUST BE DISTINCT. Stripping "-chamber"
// off the layout name rendered BOTH of the Cave of Seals' middle floors as
// "boulder" — `boulder-chamber` and `rock-switch` are two different puzzles and
// a preview that calls them the same thing is worse than one that shows a name
// you have to look up.
const LAYOUT_LABEL = {
  'snake':           'cave',
  'trap-chamber':    'traps',
  'boulder-chamber': 'hall',
  'rock-switch':     'switch',
  'spine':           'rooms',
};

/** Floor labels straight off the row — never a hardcoded list. */
export function floorNames(dg) {
  const out = [];
  for (let f = 0; f < dg.floors; f++) {
    const lay = layoutForFloor(dg, f);
    out.push(`F${f + 1} ${lay ? (LAYOUT_LABEL[lay] || lay) : 'boss'}`);
  }
  return out;
}

const skinCache = new Map();
function assetsFor(rom, donor) {
  if (skinCache.has(donor)) return skinCache.get(donor);
  const props = parseMapProperties(rom, donor);
  const a = {
    metatiles: loadTileset(rom, props.tileset),
    chrTiles: loadCHRGraphics(rom, donor),
    palettes: buildMapPalettes(rom, props),
    tileAttrs: loadNameTable(rom, props.tileset),
    tileset: props.tileset,
  };
  skinCache.set(donor, a);
  return a;
}

let state = { floor: 1, seed: Date.now(), reach: true, marks: true, grid: false, skin: 0 };
let dom = null;
let rom = null;

const C = {
  gold: '#c8a832', dim: '#888', bg: '#0e0e1a', line: '#444', panel: '#141420',
};
const btnCss = (on) =>
  `flex:1;min-width:48px;min-height:40px;padding:6px 4px;border-radius:5px;` +
  `font-family:monospace;font-size:12px;cursor:pointer;` +
  (on ? `background:${C.gold};color:#111;border:1px solid ${C.gold};font-weight:bold;`
      : `background:#1a1a28;color:${C.gold};border:1px solid ${C.line};`);

function tap(el, fn) {
  el.addEventListener('click', fn);
  el.addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, { passive: false });
}

async function romBytesFor(ctx) {
  const raw = ctx?.getFF3Buffer?.();
  if (!raw) return null;
  const bytes = new Uint8Array(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  try {
    const resp = await fetch('patches/ff3-awj.ips');
    if (resp && resp.ok) applyIPS(bytes, new Uint8Array(await resp.arrayBuffer()));
  } catch (e) { console.warn('[dungeon] IPS fetch failed, using the raw ROM', e); }
  return bytes;
}

/** Walkable tiles reachable from the entrance — the `!` of `floor-view.mjs`. */
function reachableFrom(tm, ex, ey) {
  const seen = new Uint8Array(1024); const q = [];
  const push = (x, y) => {
    if (x < 0 || x > 31 || y < 0 || y > 31) return;
    const i = y * 32 + x;
    if (!seen[i] && PASS.has(tm[i])) { seen[i] = 1; q.push(i); }
  };
  push(ex, ey); push(ex + 1, ey); push(ex - 1, ey); push(ex, ey + 1); push(ex, ey - 1);
  while (q.length) {
    const i = q.pop(); const x = i % 32, y = (i - x) / 32;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return seen;
}

/** Paint the floor exactly as the game would: metatile -> 4 CHR tiles -> palette. */
function paint(ctx2d, md, skinAssets) {
  const img = ctx2d.createImageData(PX, PX);
  const d = img.data;
  const { tilemap } = md;
  const { metatiles, chrTiles, palettes, tileAttrs } = skinAssets || md;
  const offs = [[0, 0], [8, 0], [0, 8], [8, 8]];
  for (let ty = 0; ty < W; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const raw = tilemap[ty * W + tx];
      const m = raw < 128 ? raw : raw & 0x7F;
      const meta = metatiles[m];
      if (!meta) continue;
      const pal = palettes[tileAttrs[m] & 0x03] || palettes[0];
      const rgb = pal.map((n) => NES_SYSTEM_PALETTE[n & 0x3F] || [0, 0, 0]);
      const idx = [meta.tl, meta.tr, meta.bl, meta.br];
      for (let q = 0; q < 4; q++) {
        const t = chrTiles[idx[q]];
        if (!t) continue;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const c = rgb[t[y * 8 + x]] || [0, 0, 0];
            const px = tx * TILE + offs[q][0] + x, py = ty * TILE + offs[q][1] + y;
            const o = (py * PX + px) * 4;
            d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
          }
        }
      }
    }
  }
  ctx2d.putImageData(img, 0, 0);
}

function overlay(ctx2d, md, seen) {
  const tm = md.tilemap;
  ctx2d.save();
  if (state.grid) {
    ctx2d.strokeStyle = 'rgba(255,255,255,0.10)'; ctx2d.lineWidth = 1;
    for (let i = 0; i <= W; i++) {
      ctx2d.beginPath(); ctx2d.moveTo(i * TILE + 0.5, 0); ctx2d.lineTo(i * TILE + 0.5, PX); ctx2d.stroke();
      ctx2d.beginPath(); ctx2d.moveTo(0, i * TILE + 0.5); ctx2d.lineTo(PX, i * TILE + 0.5); ctx2d.stroke();
    }
  }
  if (state.reach) {
    // Walkable but unreachable — the thing a picture alone will not show you.
    ctx2d.fillStyle = 'rgba(255,40,40,0.55)';
    for (let i = 0; i < 1024; i++) {
      if (!PASS.has(tm[i]) || seen[i]) continue;
      ctx2d.fillRect((i % 32) * TILE, ((i - (i % 32)) / 32) * TILE, TILE, TILE);
    }
  }
  if (state.marks) {
    const ring = (x, y, col, w = 2) => {
      ctx2d.strokeStyle = col; ctx2d.lineWidth = w;
      ctx2d.strokeRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
    };
    for (let i = 0; i < 1024; i++) {
      const x = i % 32, y = (i - x) / 32;
      if (tm[i] === CHEST) ring(x, y, '#ffd24a');
      else if (tm[i] === FALSE_CEILING) ring(x, y, '#4ad2ff', 3);   // secret mouth
    }
    for (const [coord, trig] of (md.triggerMap || new Map())) {
      const dest = md.dungeonDestinations?.get(`${trig.type}:${trig.trigId}`);
      if (!dest) continue;
      const [x, y] = coord.split(',').map(Number);
      ring(x, y, dest.goBack ? '#ff9a3a' : '#ff5ad2', 3);
    }
    if (md.warpTile) ring(md.warpTile.x, md.warpTile.y, '#ffffff', 3);
    // ⛔ Entrance LAST, and inset, so it nests inside rather than replacing.
    // On the deeper floors the tile you arrive on is ALSO the way back, so both
    // rings are true at once — drawn the other way round, the exit ring painted
    // over the entrance and the arrival tile looked like a plain exit.
    ctx2d.strokeStyle = '#5aff5a'; ctx2d.lineWidth = 2;
    ctx2d.strokeRect(md.entranceX * TILE + 4, md.entranceY * TILE + 4, TILE - 8, TILE - 8);
  }
  ctx2d.restore();
}

function report(md, seen) {
  const tm = md.tilemap;
  let chests = 0, bones = 0, walk = 0, unreach = 0;
  for (let i = 0; i < 1024; i++) {
    if (tm[i] === CHEST) chests++;
    if (tm[i] === BONES) bones++;
    if (PASS.has(tm[i])) { walk++; if (!seen[i]) unreach++; }
  }
  const lines = [];
  lines.push(`seed ${state.seed}`);
  lines.push(`walkable ${walk}   unreachable ${unreach}   chests ${chests}   bones ${bones}`);
  const dg = CAVES[state.skin];
  const lay = layoutForFloor(dg, state.floor);
  const cb = corridorBounds(dg);
  lines.push(`${dg.name}  f${state.floor}/${dg.floors - 1}   layout ${lay || 'BOSS CHAMBER'}   map ${dg.base + state.floor}`);
  lines.push(`donor ${dg.donorMap}   boss skin ${dg.bossSkinId}   corridors h${cb.hMin}-${cb.hMax} v${cb.vMin}-${cb.vMax}`);
  if (md.chambers && md.chambers.length) {
    lines.push(`chambers: ${md.chambers.map((c) => `${c.id}(${c.what})`).join('   ')}`);
  }
  lines.push(`entrance ${md.entranceX},${md.entranceY}   tileset ${md.tileset}   fill 0x${(md.fillTile ?? 0).toString(16)}`);

  const exits = [];
  for (const [coord, trig] of (md.triggerMap || new Map())) {
    const dest = md.dungeonDestinations?.get(`${trig.type}:${trig.trigId}`);
    if (dest) exits.push(`${coord} -> ${dest.goBack ? 'back' : 'map ' + dest.mapId}`);
  }
  lines.push(`exits: ${exits.length ? exits.join('   ') : '(none)'}`);

  const secrets = [];
  for (const [coord, v] of (md.falseWalls || new Map())) secrets.push(`${coord} -> map ${v.mapId ?? 'back'}`);
  for (const l of (md.plan?.links || [])) if (l.kind === 'secret') secrets.push(`${l.x},${l.y} tunnel -> ${l.alcove.x},${l.alcove.y}`);
  lines.push(`secrets: ${secrets.length ? secrets.join('   ') : '(none this seed)'}`);
  if (md.lockedDoors?.size) lines.push(`locked doors: ${[...md.lockedDoors].join('   ')}`);
  if (md.rockSwitch) lines.push(`rock switch: ${md.rockSwitch.rocks.map((r) => `${r.x},${r.y}`).join(' ')}  opens ${md.rockSwitch.wallTiles.length} tiles`);
  lines.push('');
  lines.push(md.plan ? describePlan(md.plan) : '(no plan recorded)');
  return lines.join('\n');
}

function redraw() {
  if (!dom || !rom) return;
  let md;
  try {
    md = generateFloor(rom, state.floor, state.seed, CAVES[state.skin]);
  } catch (e) {
    dom.out.textContent = `generateFloor threw:\n${e && e.stack ? e.stack : e}`;
    return;
  }
  const seen = reachableFrom(md.tilemap, md.entranceX, md.entranceY);
  const c2 = dom.canvas.getContext('2d');
  // The floor is already generated UNDER the skin, so it carries the right
  // tileset and the right decorations. Repainting is only needed for the
  // non-boss floors, whose art comes from the dungeon's donor.
  // The floor is generated FROM the row, so its assets are already that cave's.
  // `assetsFor` stays only as the cheap cached path for the non-boss tileset.
  const skinAssets = md.tileset === 0 ? assetsFor(rom, CAVES[state.skin].donorMap) : null;
  paint(c2, md, skinAssets);
  overlay(c2, md, seen);
  dom.out.textContent = report(md, seen);
  for (const [i, b] of dom.floorBtns.entries()) b.style.cssText = btnCss(i === state.floor);
  for (const [i, b] of dom.skinBtns.entries()) b.style.cssText = btnCss(i === state.skin);
  dom.tgl.reach.style.cssText = btnCss(state.reach);
  dom.tgl.marks.style.cssText = btnCss(state.marks);
  dom.tgl.grid.style.cssText = btnCss(state.grid);
}

export function mount(root, ctx) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2px;';

  const row = (gap = 4) => {
    const r = document.createElement('div');
    r.style.cssText = `display:flex;gap:${gap}px;margin-bottom:6px;`;
    return r;
  };

  // Floors. ⛔ REBUILT WHEN THE CAVE CHANGES — floor COUNT is a property of the
  // row (Altar Cave and the Cave of Seals are both 5 today, but a third dungeon
  // need not be) and so are the labels, which name the LAYOUT rather than a
  // hardcoded guess at what floor 2 contains.
  const floorRow = row();
  let floorBtns = [];
  function buildFloorRow() {
    floorRow.textContent = '';
    const dg = CAVES[state.skin];
    if (state.floor >= dg.floors) state.floor = dg.floors - 1;
    floorBtns = floorNames(dg).map((name, i) => {
      const b = document.createElement('button');
      b.textContent = name;
      b.style.cssText = btnCss(i === state.floor);
      b.style.fontSize = '10px';
      tap(b, () => { state.floor = i; redraw(); });
      floorRow.appendChild(b);
      return b;
    });
    if (dom) dom.floorBtns = floorBtns;
  }
  buildFloorRow();
  wrap.appendChild(floorRow);

  // Skin
  const skinRow = row();
  const skinBtns = CAVES.map((dg, i) => {
    const b = document.createElement('button');
    b.textContent = dg.id.toUpperCase();
    b.style.cssText = btnCss(i === state.skin);
    tap(b, () => { state.skin = i; buildFloorRow(); redraw(); });
    skinRow.appendChild(b);
    return b;
  });
  wrap.appendChild(skinRow);

  // Seed
  const seedRow = row();
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.style.cssText = btnCss(false);
    tap(b, fn); seedRow.appendChild(b); return b;
  };
  mkBtn('◀ PREV', () => { state.seed -= 7919; redraw(); });
  mkBtn('REROLL', () => { state.seed = Date.now(); redraw(); });
  mkBtn('NEXT ▶', () => { state.seed += 7919; redraw(); });
  wrap.appendChild(seedRow);

  // Overlays
  const tglRow = row();
  const mkTgl = (label, key) => {
    const b = document.createElement('button');
    b.textContent = label; b.style.cssText = btnCss(state[key]);
    tap(b, () => { state[key] = !state[key]; redraw(); });
    tglRow.appendChild(b); return b;
  };
  const tgl = { reach: mkTgl('UNREACHED', 'reach'), marks: mkTgl('MARKS', 'marks'), grid: mkTgl('GRID', 'grid') };
  wrap.appendChild(tglRow);

  const canvas = document.createElement('canvas');
  canvas.width = PX; canvas.height = PX;
  // Square, full width, never wider than the viewport — and crisp, since
  // scaling NES art smoothly turns it to mush.
  canvas.style.cssText = 'width:100%;max-width:100vw;aspect-ratio:1/1;display:block;' +
    'image-rendering:pixelated;background:#000;border:1px solid #333;border-radius:4px;';
  wrap.appendChild(canvas);

  const legend = document.createElement('div');
  legend.style.cssText = `color:${C.dim};font-family:monospace;font-size:10px;padding:6px 2px;line-height:1.5;`;
  legend.innerHTML =
    '<span style="color:#5aff5a">▢ entrance</span> &nbsp; ' +
    '<span style="color:#ff5ad2">▢ exit</span> &nbsp; ' +
    '<span style="color:#ff9a3a">▢ back</span> &nbsp; ' +
    '<span style="color:#ffd24a">▢ chest</span> &nbsp; ' +
    '<span style="color:#4ad2ff">▢ secret</span> &nbsp; ' +
    '<span style="color:#ffffff">▢ warp</span> &nbsp; ' +
    '<span style="color:#ff4040">■ walkable but UNREACHABLE</span>';
  wrap.appendChild(legend);

  const out = document.createElement('pre');
  out.style.cssText = `color:${C.gold};background:${C.panel};border:1px solid ${C.line};border-radius:4px;` +
    'font-family:monospace;font-size:10px;line-height:1.45;padding:8px;margin:0 0 10px 0;' +
    'white-space:pre-wrap;word-break:break-word;';
  out.textContent = 'loading ROM…';
  wrap.appendChild(out);

  root.appendChild(wrap);
  dom = { canvas, out, floorBtns, skinBtns, tgl };

  romBytesFor(ctx).then((bytes) => {
    if (!bytes) { out.textContent = 'No FF3 ROM loaded — load it on the title screen first.'; return; }
    rom = bytes;
    redraw();
  });
}

export function unmount() {
  dom = null;
  // `rom` is kept: re-mounting the tab should not re-fetch and re-patch it.
}
