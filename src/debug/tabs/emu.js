// EMU tab — jsnes-backed NES emulator for PPU/OAM/palette capture.
// jsnes is loaded via <script src="lib/jsnes.min.js"> in index.html, exposed as window.jsnes.

const SCREEN_W = 256;
const SCREEN_H = 240;

// Controller button indices (jsnes.Controller)
const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };
const KEY_MAP = {
  'w': BTN.UP, 'a': BTN.LEFT, 's': BTN.DOWN, 'd': BTN.RIGHT,
  'ArrowUp': BTN.UP, 'ArrowLeft': BTN.LEFT, 'ArrowDown': BTN.DOWN, 'ArrowRight': BTN.RIGHT,
  'j': BTN.B, 'k': BTN.A,
  '/': BTN.START, '.': BTN.SELECT,
};

let nes = null;
let dom = null;
let ctx = null;
let running = false;
let rafId = 0;
let frameCount = 0;
let imgData = null;
let img32 = null;
let canvasCtx = null;
let romStrCache = null;

export function mount(root, context) {
  ctx = context;
  dom = _buildDOM(root);

  if (!window.jsnes) { _status('jsnes library not loaded (check lib/jsnes.min.js)', true); return; }
  const rom = ctx.getFF3Buffer();
  if (!rom) { _status('No ROM loaded — load FF3 on the title screen first', true); return; }

  _initEmulator(rom);
}

export function unmount() {
  _stop();
  if (dom?._keyDown) window.removeEventListener('keydown', dom._keyDown, true);
  if (dom?._keyUp) window.removeEventListener('keyup', dom._keyUp, true);
  if (dom?.root) dom.root.remove();
  nes = null; dom = null; ctx = null; imgData = null; img32 = null; canvasCtx = null;
}

function _initEmulator(romBuffer) {
  _status(`ROM ${romBuffer.byteLength} bytes, converting…`);
  const bytes = new Uint8Array(romBuffer);
  let romStr = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    romStr += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  romStrCache = romStr;

  canvasCtx = dom.canvas.getContext('2d');
  imgData = canvasCtx.createImageData(SCREEN_W, SCREEN_H);
  img32 = new Uint32Array(imgData.data.buffer);

  try {
    nes = new window.jsnes.NES({
      onFrame: _onFrame,
      onAudioSample: () => {},
      onStatusUpdate: (s) => { console.log('[jsnes]', s); _status('jsnes: ' + s); },
      onBatteryRamWrite: () => {},
    });
  } catch (e) {
    _status('NES ctor failed: ' + e.message, true); console.error(e); return;
  }

  _status('loading ROM into jsnes…');
  try {
    nes.loadROM(romStr);
  } catch (e) {
    _status('loadROM failed: ' + e.message, true);
    console.error('[emu] loadROM', e);
    return;
  }

  // Mapper info
  const mapper = nes.rom?.mapperType;
  const prgCount = nes.rom?.romCount;
  const chrCount = nes.rom?.vromCount;
  _status(`ROM ok — mapper ${mapper}, PRG ${prgCount}×16KB, CHR ${chrCount}×8KB. Starting…`);

  frameCount = 0;
  _start();

  // If no frame renders within 500ms, report it.
  setTimeout(() => {
    if (frameCount === 0 && running) _status('no frames after 500ms — jsnes may be stuck', true);
  }, 500);
}

function _onFrame(buffer) {
  // jsnes frame buffer holds RGB packed as 0x00BBGGRR — we OR in full alpha.
  for (let i = 0; i < SCREEN_W * SCREEN_H; i++) img32[i] = 0xFF000000 | buffer[i];
  canvasCtx.putImageData(imgData, 0, 0);
  frameCount++;
  if (dom?.status) dom.status.textContent = running ? `frame ${frameCount}` : `paused @ frame ${frameCount}`;
}

function _start() {
  if (running) return;
  running = true;
  const tick = () => {
    if (!running || !nes) return;
    nes.frame();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function _stop() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function _togglePause() {
  if (running) { _stop(); dom.btnPause.textContent = 'PLAY'; _status(`paused @ frame ${frameCount}`); }
  else { _start(); dom.btnPause.textContent = 'PAUSE'; }
}

function _step() {
  if (!nes) return;
  if (running) _togglePause();
  nes.frame();
}

function _reset() {
  if (!window.jsnes || !romStrCache) return;
  _stop();
  try {
    nes = new window.jsnes.NES({
      onFrame: _onFrame,
      onAudioSample: () => {},
      onStatusUpdate: (s) => { console.log('[jsnes]', s); },
      onBatteryRamWrite: () => {},
    });
    nes.loadROM(romStrCache);
  } catch (e) {
    _status('reset failed: ' + e.message, true);
    console.error('[emu] reset', e);
    return;
  }
  frameCount = 0;
  _status('reset — running');
  dom.btnPause.textContent = 'PAUSE';
  _start();
}

function _status(msg, err = false) {
  if (!dom?.status) return;
  dom.status.textContent = msg;
  dom.status.style.color = err ? '#f66' : '#c8a832';
}

// ── Capture ─────────────────────────────────────────────────────────────────

function _capture() {
  if (!nes) return;
  const wasRunning = running;
  if (running) _stop();
  const out = [];
  out.push(`// Capture at frame ${frameCount}`);
  out.push('');
  out.push(_dumpOAM());
  out.push('');
  out.push(_dumpPalette());
  out.push('');
  out.push('// Sprite pattern table at PPU $1000 — 256 tiles, raw 2BPP bytes');
  out.push(_dumpPatternTable(256, 256)); // tiles 256-511 = $1000-$1FFF
  dom.output.value = out.join('\n');
  if (wasRunning) _start();
}

function _dumpOAM() {
  const oam = nes.ppu.spriteMem; // 256 bytes
  const lines = ['// OAM (64 sprites: Y, tile, attr, X)'];
  for (let i = 0; i < 64; i++) {
    const y = oam[i * 4], t = oam[i * 4 + 1], a = oam[i * 4 + 2], x = oam[i * 4 + 3];
    if (y >= 0xF0) continue; // hidden
    lines.push(`//  [${String(i).padStart(2)}] y=${String(y).padStart(3)}  tile=$${_hex(t, 2)}  attr=$${_hex(a, 2)}  x=${String(x).padStart(3)}  pal${(a & 3)}${(a & 0x80) ? ' VFLIP' : ''}${(a & 0x40) ? ' HFLIP' : ''}`);
  }
  return lines.join('\n');
}

function _dumpPalette() {
  const v = nes.ppu.vramMem;
  const lines = ['// PPU palette ($3F00-$3F1F)'];
  for (let p = 0; p < 8; p++) {
    const row = [];
    for (let i = 0; i < 4; i++) row.push('0x' + _hex(v[0x3F00 + p * 4 + i], 2));
    lines.push(`//  ${p < 4 ? 'BG' : 'SP'}${p % 4}: [${row.join(', ')}]`);
  }
  return lines.join('\n');
}

function _dumpPatternTable(startTile, count) {
  // jsnes decodes pattern tables into nes.ppu.ptTile[] (512 tiles).
  // We re-encode each to raw 2BPP (16 bytes per tile).
  const tiles = nes.ppu.ptTile;
  if (!tiles) return '// pattern table not available';
  const lines = [];
  for (let i = 0; i < count; i++) {
    const idx = startTile + i;
    const t = tiles[idx];
    if (!t || !t.pix) continue;
    const bytes = _encodeTile(t.pix);
    const label = `tile $${_hex(idx, 3)} (PPU $${_hex((idx & 0xFF) * 16 + (idx >= 256 ? 0x1000 : 0), 4)})`;
    lines.push(`new Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]), // ${label}`);
  }
  return lines.join('\n');
}

function _encodeTile(pix) {
  const out = new Uint8Array(16);
  for (let row = 0; row < 8; row++) {
    let bp0 = 0, bp1 = 0;
    for (let col = 0; col < 8; col++) {
      const v = pix[row * 8 + col] & 3;
      bp0 |= (v & 1) << (7 - col);
      bp1 |= ((v >> 1) & 1) << (7 - col);
    }
    out[row] = bp0;
    out[row + 8] = bp1;
  }
  return out;
}

function _dumpTileByIndex() {
  const raw = dom.tileInput.value.trim();
  if (!raw) { _status('enter a tile index (decimal or $hex)', true); return; }
  const idx = raw.startsWith('$') ? parseInt(raw.slice(1), 16) : parseInt(raw, raw.startsWith('0x') ? 16 : 10);
  if (isNaN(idx) || idx < 0 || idx > 511) { _status('tile index must be 0-511', true); return; }
  const t = nes.ppu.ptTile?.[idx];
  if (!t) { _status('tile not available', true); return; }
  const bytes = _encodeTile(t.pix);
  const label = `tile $${_hex(idx, 3)} @ PPU $${_hex((idx & 0xFF) * 16 + (idx >= 256 ? 0x1000 : 0), 4)}`;
  dom.output.value = `// ${label} (captured @ frame ${frameCount})\nnew Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]),`;
}

function _hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// ── Input ───────────────────────────────────────────────────────────────────

function _press(btn) { if (nes) nes.buttonDown(1, btn); }
function _release(btn) { if (nes) nes.buttonUp(1, btn); }

function _installKeys() {
  const pressed = new Set();
  dom._keyDown = (e) => {
    const btn = KEY_MAP[e.key];
    if (btn === undefined) return;
    if (!pressed.has(btn)) { _press(btn); pressed.add(btn); }
    e.preventDefault(); e.stopImmediatePropagation();
  };
  dom._keyUp = (e) => {
    const btn = KEY_MAP[e.key];
    if (btn === undefined) return;
    if (pressed.has(btn)) { _release(btn); pressed.delete(btn); }
    e.preventDefault(); e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', dom._keyDown, true);
  window.addEventListener('keyup', dom._keyUp, true);
}

function _bindButton(el, btn) {
  const press = (e) => { e?.preventDefault?.(); _press(btn); el.style.background = '#3a3a50'; };
  const rel = (e) => { e?.preventDefault?.(); _release(btn); el.style.background = '#1e1e2e'; };
  el.addEventListener('mousedown', press);
  el.addEventListener('mouseup', rel);
  el.addEventListener('mouseleave', rel);
  el.addEventListener('touchstart', press, { passive: false });
  el.addEventListener('touchend', rel, { passive: false });
  el.addEventListener('touchcancel', rel, { passive: false });
}

// ── DOM ─────────────────────────────────────────────────────────────────────

function _buildDOM(parent) {
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;overflow:auto;';

  const top = document.createElement('div');
  top.style.cssText = 'display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;';

  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'background:#000;display:inline-block;flex-shrink:0;border:1px solid #333;';
  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_W; canvas.height = SCREEN_H;
  canvas.style.cssText = `width:min(${SCREEN_W}px,70vw);height:auto;aspect-ratio:${SCREEN_W}/${SCREEN_H};image-rendering:pixelated;display:block;`;
  canvasWrap.appendChild(canvas);
  top.appendChild(canvasWrap);

  const rightCol = document.createElement('div');
  rightCol.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1;min-width:220px;';

  const status = document.createElement('div');
  status.style.cssText = 'color:#c8a832;font-size:10px;padding:5px 8px;background:#1e1e2e;border:1px solid #444;border-radius:3px;font-family:monospace;';
  status.textContent = 'initializing...';
  rightCol.appendChild(status);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#c8a832;font-family:monospace;font-size:11px;cursor:pointer;white-space:nowrap;';
    b.addEventListener('click', onClick);
    return b;
  };
  const btnPause = mkBtn('PAUSE', _togglePause);
  const btnStep = mkBtn('STEP', _step);
  const btnReset = mkBtn('RESET', _reset);
  const btnCapture = mkBtn('CAPTURE', _capture);
  btnRow.append(btnPause, btnStep, btnReset, btnCapture);
  rightCol.appendChild(btnRow);

  // Tile dump input
  const tileRow = document.createElement('div');
  tileRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const tileLabel = document.createElement('span');
  tileLabel.textContent = 'Tile:';
  tileLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  const tileInput = document.createElement('input');
  tileInput.placeholder = '0-511 or $xxx';
  tileInput.style.cssText = 'flex:1;min-width:0;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  const btnTileDump = mkBtn('DUMP', _dumpTileByIndex);
  tileRow.append(tileLabel, tileInput, btnTileDump);
  rightCol.appendChild(tileRow);

  // Controller pad
  const pad = _buildPad();
  rightCol.appendChild(pad);

  const legend = document.createElement('div');
  legend.style.cssText = 'color:#666;font-size:10px;font-family:monospace;line-height:1.5;';
  legend.innerHTML = 'Keys: <b>WASD</b>/arrows dpad · <b>K</b> A · <b>J</b> B · <b>/</b> Start · <b>.</b> Select';
  rightCol.appendChild(legend);

  top.appendChild(rightCol);
  root.appendChild(top);

  const output = document.createElement('textarea');
  output.readOnly = true;
  output.placeholder = 'CAPTURE output goes here. Paste into src/data/job-sprites.js etc.';
  output.style.cssText = 'flex:1;min-height:140px;background:#0f0f18;color:#ccc;font-family:monospace;font-size:10px;border:1px solid #333;border-radius:3px;padding:6px;resize:vertical;';
  root.appendChild(output);

  parent.appendChild(root);

  const d = { root, canvas, status, btnPause, btnStep, btnReset, btnCapture, tileInput, btnTileDump, output };
  dom = d;
  _installKeys();
  return d;
}

function _buildPad() {
  const pad = document.createElement('div');
  pad.style.cssText = 'display:flex;gap:20px;align-items:center;';

  const dpad = document.createElement('div');
  dpad.style.cssText = 'display:grid;grid-template-columns:repeat(3,34px);grid-template-rows:repeat(3,34px);gap:2px;';
  const padBtnCss = 'background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#c8a832;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;';
  const _ = () => { const e = document.createElement('div'); e.style.visibility = 'hidden'; return e; };
  const up = document.createElement('button'); up.textContent = '▲'; up.style.cssText = padBtnCss;
  const dn = document.createElement('button'); dn.textContent = '▼'; dn.style.cssText = padBtnCss;
  const lf = document.createElement('button'); lf.textContent = '◀'; lf.style.cssText = padBtnCss;
  const rt = document.createElement('button'); rt.textContent = '▶'; rt.style.cssText = padBtnCss;
  dpad.append(_(), up, _(), lf, _(), rt, _(), dn, _());
  _bindButton(up, BTN.UP);
  _bindButton(dn, BTN.DOWN);
  _bindButton(lf, BTN.LEFT);
  _bindButton(rt, BTN.RIGHT);
  pad.appendChild(dpad);

  const actCol = document.createElement('div');
  actCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  const actRow = document.createElement('div');
  actRow.style.cssText = 'display:flex;gap:4px;';
  const btnB = document.createElement('button'); btnB.textContent = 'B'; btnB.style.cssText = padBtnCss + 'width:40px;height:40px;border-radius:50%;';
  const btnA = document.createElement('button'); btnA.textContent = 'A'; btnA.style.cssText = padBtnCss + 'width:40px;height:40px;border-radius:50%;';
  actRow.append(btnB, btnA);
  _bindButton(btnA, BTN.A);
  _bindButton(btnB, BTN.B);
  const selRow = document.createElement('div');
  selRow.style.cssText = 'display:flex;gap:4px;';
  const btnSel = document.createElement('button'); btnSel.textContent = 'SEL'; btnSel.style.cssText = padBtnCss + 'padding:4px 8px;font-size:10px;';
  const btnStart = document.createElement('button'); btnStart.textContent = 'START'; btnStart.style.cssText = padBtnCss + 'padding:4px 8px;font-size:10px;';
  selRow.append(btnSel, btnStart);
  _bindButton(btnSel, BTN.SELECT);
  _bindButton(btnStart, BTN.START);
  actCol.append(actRow, selRow);
  pad.appendChild(actCol);

  return pad;
}
