// SPRITES tab — tile/sprite/poses viewer. Moved from index.html konami viewer.
//
// Context expected on mount: { getFF3Buffer(), getFF12Buffer() }

import { decodeTile, NES_SYSTEM_PALETTE } from '../../tile-decoder.js';

const TILES_PER_PAGE = 128;
const SPRITES_PER_PAGE = 16;

const ONION_KNIGHT_OFFSET = 0x50010;
const ONION_FRAME_STEP = 0x100;

const CHR_BANKS = [
  { label: 'BG $00',    off: 0x00010 },
  { label: 'BG $02',    off: 0x04010 },
  { label: 'BG $04',    off: 0x08010 },
  { label: 'BG $0A',    off: 0x14010 },
  { label: 'BG $0B',    off: 0x16010 },
  { label: 'BG $0E',    off: 0x1C010 },
  { label: 'BG $0F',    off: 0x1E010 },
  { label: 'MON $20',   off: 0x40010 },
  { label: 'MON $21',   off: 0x42010 },
  { label: 'MON $22',   off: 0x44010 },
  { label: 'MON $23',   off: 0x46010 },
  { label: 'MON $24',   off: 0x48010 },
  { label: 'MON $25',   off: 0x4A010 },
  { label: 'MON $26',   off: 0x4C010 },
  { label: 'MON $27',   off: 0x4E010 },
  { label: 'CHAR $28',  off: 0x50010 },
  { label: 'CHAR $29',  off: 0x52010 },
  { label: 'CHAR $2A',  off: 0x54010 },
  { label: 'CHAR $2B',  off: 0x56010 },
  { label: 'FX $30',    off: 0x60010 },
];

const BATTLE_PALETTES = [
  [0x0F, 0x36, 0x30, 0x16],
  [0x0F, 0x16, 0x26, 0x36],
  [0x0F, 0x11, 0x21, 0x31],
  [0x0F, 0x0A, 0x1A, 0x2A],
];

// Onion Knight hardcoded pose tiles (historical reference copy for POSES view).
const OK_IDLE_T0 = new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]);
const OK_IDLE_T1 = new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]);
const OK_IDLE_T2 = new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]);
const OK_IDLE_T3 = new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]);
const OK_LEG_L   = new Uint8Array([0xCC,0x58,0x2F,0x3F,0x3F,0x1F,0x00,0x00, 0x1E,0x5F,0x3F,0x3F,0x3F,0x1F,0x07,0x0F]);
const OK_LEG_R   = new Uint8Array([0xD8,0x70,0x80,0xE0,0xE0,0xC0,0x00,0x00, 0x1C,0x74,0x84,0xE6,0xE6,0xC6,0xC7,0xC7]);
const OK_L_BACK_T3 = new Uint8Array([0x13,0x87,0x57,0xF8,0x7E,0x3C,0x1C,0x08, 0x50,0x30,0x30,0x38,0xFE,0x7C,0xFE,0xFA]);
const OK_L_FWD_T2 = new Uint8Array([0x1F,0x04,0x16,0x16,0x0C,0x08,0x38,0x7C, 0x00,0x00,0x00,0x00,0x11,0x03,0x38,0x7D]);
const OK_L_FWD_T3 = new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x00,0x00, 0x59,0x32,0x38,0x0C,0x80,0xC0,0x00,0x60]);
const OK_R_BACK_T2 = new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26, 0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]);
const OK_R_FWD_T2 = new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]);
const OK_VICTORY = [
  new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]),
  new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]),
  new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]),
  new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]),
];
const OK_KNEEL = [
  new Uint8Array([0x00,0x00,0x00,0x00,0x02,0x05,0x0B,0x00, 0x00,0x00,0x00,0x00,0x03,0x07,0x0F,0x1F]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x80,0xB8,0xDC,0xEE, 0x00,0x00,0x00,0x00,0x9B,0xBE,0xDD,0xEF]),
  new Uint8Array([0x00,0x03,0x07,0x05,0x01,0x01,0x1B,0x3B, 0x20,0x10,0x00,0x00,0x00,0x04,0x00,0x20]),
  new Uint8Array([0x36,0x1A,0xC6,0x20,0x92,0x81,0xDC,0xDE, 0xF6,0x3A,0x16,0x0C,0x0E,0x21,0x04,0x06]),
];
const OK_LEG_L_BACK_L  = new Uint8Array([0xC6,0x4C,0x37,0x3F,0x3F,0x1F,0x00,0x00, 0x1F,0x5F,0x3F,0x3F,0xFF,0xFF,0x78,0x39]);
const OK_LEG_R_BACK_L  = new Uint8Array([0x00,0x00,0xF0,0xF0,0xE0,0xC0,0x00,0x00, 0xE2,0xC2,0xF3,0xF1,0xE1,0xF1,0xF1,0xE1]);
const OK_LEG_L_FWD_L   = new Uint8Array([0xDC,0xD8,0x04,0x3C,0x3C,0x1C,0x00,0x00, 0x1D,0x1D,0x05,0x3D,0xFD,0xFD,0x79,0x39]);
const OK_LEG_R_FWD_L   = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x70,0x78,0xFC,0xBE,0xFF,0xFF,0xFC,0xE0]);
const OK_LEG_L_BACK_R  = new Uint8Array([0x06,0x0C,0x37,0x3F,0x3F,0x1F,0x00,0x00, 0x1E,0x1F,0x3F,0x3F,0xFF,0xFF,0x78,0x39]);
const OK_LEG_R_SWING   = new Uint8Array([0xD8,0x70,0x80,0xF0,0xE0,0xC0,0x00,0x00, 0x1C,0x74,0x86,0xF2,0xE3,0xF1,0xF1,0xE1]);
const OK_LEG_L_KNEEL   = new Uint8Array([0x38,0x18,0x03,0x05,0x0F,0x07,0x07,0x03, 0x38,0x1B,0x07,0x17,0x6F,0x77,0x77,0x33]);
const OK_LEG_R_KNEEL   = new Uint8Array([0x0E,0xCC,0x80,0xF8,0xE0,0xC0,0xC0,0xC0, 0x0E,0xEC,0xF2,0xF9,0xED,0xDD,0xDD,0xD9]);
const OK_LEG_L_VICTORY = new Uint8Array([0x37,0x1F,0x0F,0x0F,0x07,0x00,0x00,0x00, 0x3F,0xDF,0xEF,0xEF,0x67,0x08,0x07,0x00]);
const OK_LEG_R_VICTORY = new Uint8Array([0xE0,0x80,0x00,0x00,0x00,0x00,0x00,0x00, 0xE2,0xB2,0x73,0x73,0x63,0x03,0xFB,0x00]);
const OK_DEATH_T = [
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x03,0x18,0x38, 0x00,0x00,0x00,0x00,0x00,0x00,0x1C,0x3F]),
  new Uint8Array([0x00,0x10,0x00,0x00,0x00,0x00,0x89,0x3B, 0x10,0x28,0x10,0x10,0x00,0x00,0x10,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x10,0x08,0x94, 0x00,0x00,0x00,0x40,0xA0,0x30,0x38,0x3C]),
  new Uint8Array([0x3E,0x3D,0x3C,0x3D,0x3B,0x3A,0x1B,0x01, 0x3F,0xBF,0xFE,0xFC,0xFA,0xFA,0xDB,0x01]),
  new Uint8Array([0x3F,0x39,0x3B,0x8E,0xCC,0x40,0xC1,0x8D, 0x90,0x80,0x00,0x10,0x61,0x76,0xF7,0xAD]),
  new Uint8Array([0x98,0x3C,0x30,0x68,0xD0,0xB8,0x30,0xC0, 0x3C,0x7C,0x70,0xEA,0xDD,0xBB,0x7D,0xFA]),
];
const _EMPTY = new Uint8Array(16);

const OK_POSES = [
  { label: 'IDLE',         tiles: [OK_IDLE_T0, OK_IDLE_T1, OK_IDLE_T2, OK_IDLE_T3, OK_LEG_L, OK_LEG_R], rows: 3 },
  { label: 'L BACK SWING', tiles: [OK_IDLE_T0, OK_IDLE_T1, OK_IDLE_T2, OK_L_BACK_T3, OK_LEG_L_BACK_L, OK_LEG_R_BACK_L], rows: 3 },
  { label: 'L FWD SWING',  tiles: [OK_IDLE_T0, OK_IDLE_T1, OK_L_FWD_T2, OK_L_FWD_T3, OK_LEG_L_FWD_L, OK_LEG_R_FWD_L], rows: 3 },
  { label: 'R BACK SWING', tiles: [OK_IDLE_T0, OK_IDLE_T1, OK_R_BACK_T2, OK_IDLE_T3, OK_LEG_L_BACK_R, OK_LEG_R_SWING], rows: 3 },
  { label: 'R FWD SWING',  tiles: [OK_IDLE_T0, OK_IDLE_T1, OK_R_FWD_T2, OK_IDLE_T3, OK_LEG_L, OK_LEG_R_SWING], rows: 3 },
  { label: 'KNEEL',        tiles: [...OK_KNEEL, OK_LEG_L_KNEEL, OK_LEG_R_KNEEL], rows: 3 },
  { label: 'VICTORY',      tiles: [...OK_VICTORY, OK_LEG_L_VICTORY, OK_LEG_R_VICTORY], rows: 3 },
  { label: 'HIT',          tiles: [_EMPTY, _EMPTY, _EMPTY, _EMPTY, _EMPTY, _EMPTY], rows: 3 },
  { label: 'DEATH',        tiles: [...OK_DEATH_T], rows: 2, cols: 3 },
];

// --- Per-mount state (reset on unmount) ---
let ctx = null;
let dom = null;
let tilePage = 0;
let tileBaseOffset = 16;
let tileRomBuffer = null;
let spriteMode = false;
let spriteRowMajor = true;
let spriteTall = false;
let chrBankIdx = 15;
let spritePalIdx = 0;
let onionFrameIdx = 0;
let posesMode = false;
let poseTiles = [];
let editPoseIdx = -1;
let editSlotIdx = -1;

export function mount(root, context) {
  ctx = context;
  _resetState();
  dom = _buildDOM(root);
  _wireEvents();
  _openDefault();
}

export function unmount() {
  if (dom?._keyHandler) window.removeEventListener('keydown', dom._keyHandler, true);
  if (dom?.root) dom.root.remove();
  if (dom?.exportOverlay) dom.exportOverlay.remove();
  ctx = null;
  dom = null;
  poseTiles = [];
}

function _resetState() {
  tilePage = 0;
  tileBaseOffset = 16;
  spriteMode = false;
  spriteRowMajor = true;
  spriteTall = false;
  chrBankIdx = 15;
  spritePalIdx = 0;
  onionFrameIdx = 0;
  posesMode = false;
  editPoseIdx = -1;
  editSlotIdx = -1;
}

function _buildDOM(parent) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;gap:6px;';

  const header = document.createElement('div');
  header.style.cssText = 'color:#c8a832;font-size:9px;letter-spacing:1px;text-align:center;padding-bottom:4px;border-bottom:1px solid #333;flex-shrink:0;';
  header.textContent = 'ROM TILES';
  wrap.appendChild(header);

  const jumpRow = document.createElement('div');
  jumpRow.style.cssText = 'display:flex;gap:8px;padding:2px 0;flex-shrink:0;flex-wrap:wrap;';
  const mkBtn = (label, active = false, hidden = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:6px 10px;background:#1e1e2e;border:1px solid ${active ? '#c8a832' : '#444'};border-radius:4px;color:${active ? '#c8a832' : '#888'};font-family:monospace;font-size:11px;cursor:pointer;white-space:nowrap;`;
    if (hidden) b.style.display = 'none';
    b._active = active;
    b._setActive = (on) => {
      b._active = on;
      b.style.borderColor = on ? '#c8a832' : '#444';
      b.style.color = on ? '#c8a832' : '#888';
    };
    return b;
  };
  const rom3 = mkBtn('FF3', true);
  const rom12 = mkBtn('FF1&2');
  const sprite = mkBtn('SPRITE');
  const layout = mkBtn('ROW', false, true);
  const height = mkBtn('24', false, true);
  const pal = mkBtn('PAL0', false, true);
  const bank = mkBtn('CHAR $28');
  const poses = mkBtn('POSES');
  const exportBtn = mkBtn('EXPORT', false, true);
  const offset = document.createElement('input');
  offset.type = 'text';
  offset.placeholder = 'offset (hex)';
  offset.autocomplete = 'off';
  offset.autocorrect = 'off';
  offset.autocapitalize = 'off';
  offset.spellcheck = false;
  offset.style.cssText = 'flex:1;min-width:100px;background:#1e1e2e;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-family:monospace;font-size:13px;padding:6px 8px;outline:none;';
  const go = document.createElement('button');
  go.textContent = 'GO';
  go.style.cssText = 'padding:6px 14px;background:#2a2a3e;border:1px solid #555;border-radius:4px;color:#c8a832;font-family:monospace;font-size:13px;cursor:pointer;';
  [rom3, rom12, sprite, layout, height, pal, bank, poses, exportBtn, offset, go].forEach(el => jumpRow.appendChild(el));
  wrap.appendChild(jumpRow);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;flex:1;min-height:0;align-content:flex-start;padding-bottom:4px;';
  wrap.appendChild(grid);

  const frameRow = document.createElement('div');
  frameRow.style.cssText = 'display:none;align-items:center;gap:8px;padding:2px 0;flex-shrink:0;';
  const fprev = mkBtn('◀ FRAME');
  const flabel = document.createElement('span');
  flabel.style.cssText = 'color:#c8a832;font-size:9px;font-family:monospace;padding:0 6px;align-self:center;';
  flabel.textContent = 'F0';
  const fnext = mkBtn('FRAME ▶');
  [fprev, flabel, fnext].forEach(el => frameRow.appendChild(el));
  wrap.appendChild(frameRow);

  const nav = document.createElement('div');
  nav.style.cssText = 'display:flex;justify-content:center;gap:16px;padding:4px 0;flex-shrink:0;';
  const navBtnCss = 'width:64px;height:40px;background:#1e1e2e;border:2px solid #444;border-radius:8px;color:#c8a832;font-size:18px;cursor:pointer;-webkit-tap-highlight-color:transparent;';
  const up = document.createElement('button');  up.textContent = '▲'; up.style.cssText = navBtnCss;
  const down = document.createElement('button'); down.textContent = '▼'; down.style.cssText = navBtnCss;
  nav.appendChild(up); nav.appendChild(down);
  wrap.appendChild(nav);

  const exportOverlay = document.createElement('div');
  exportOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0a10;z-index:600;padding:8px;box-sizing:border-box;flex-direction:column;gap:8px;';
  const exportHead = document.createElement('div');
  exportHead.style.cssText = 'color:#c8a832;font-size:9px;font-family:monospace;text-align:center;padding-bottom:6px;border-bottom:1px solid #333;';
  exportHead.textContent = 'POSE BYTES — COPY INTO game.js';
  const exportText = document.createElement('textarea');
  exportText.readOnly = true;
  exportText.style.cssText = 'flex:1;background:#1e1e2e;color:#e0e0e0;font-family:monospace;font-size:10px;border:1px solid #444;border-radius:4px;padding:8px;resize:none;width:100%;height:70vh;';
  const exportClose = document.createElement('button');
  exportClose.textContent = 'CLOSE';
  exportClose.style.cssText = 'padding:10px;background:#1e1e2e;border:2px solid #444;border-radius:8px;color:#c8a832;font-family:monospace;font-size:13px;cursor:pointer;';
  exportOverlay.append(exportHead, exportText, exportClose);

  parent.appendChild(wrap);
  parent.appendChild(exportOverlay);

  return { root: wrap, exportOverlay, header, jumpRow, grid, frameRow, flabel, nav,
    rom3, rom12, sprite, layout, height, pal, bank, poses, exportBtn, offset, go,
    fprev, fnext, up, down, exportText, exportClose };
}

function _wireEvents() {
  dom.rom3.addEventListener('click', () => {
    tileRomBuffer = ctx.getFF3Buffer(); tilePage = 0; tileBaseOffset = 16;
    dom.rom3._setActive(true); dom.rom12._setActive(false);
    _renderTilePage();
  });
  dom.rom12.addEventListener('click', () => {
    tileRomBuffer = ctx.getFF12Buffer(); tilePage = 0; tileBaseOffset = 16;
    dom.rom12._setActive(true); dom.rom3._setActive(false);
    _renderTilePage();
  });

  dom.bank.addEventListener('click', () => {
    chrBankIdx = (chrBankIdx + 1) % CHR_BANKS.length;
    const b = CHR_BANKS[chrBankIdx];
    tileBaseOffset = b.off;
    tilePage = 0;
    dom.bank.textContent = b.label;
    dom.offset.value = b.off.toString(16).toUpperCase();
    _renderTilePage();
  });

  dom.sprite.addEventListener('click', () => {
    spriteMode = !spriteMode;
    dom.sprite._setActive(spriteMode);
    dom.layout.style.display = spriteMode ? '' : 'none';
    dom.height.style.display = spriteMode ? '' : 'none';
    dom.pal.style.display = spriteMode ? '' : 'none';
    dom.frameRow.style.display = spriteMode ? 'flex' : 'none';
    tilePage = 0;
    _renderTilePage();
  });

  dom.pal.addEventListener('click', () => {
    spritePalIdx = (spritePalIdx + 1) % BATTLE_PALETTES.length;
    dom.pal.textContent = 'PAL' + spritePalIdx;
    if (posesMode) _renderPosesGrid(); else _renderTilePage();
  });

  dom.layout.addEventListener('click', () => {
    spriteRowMajor = !spriteRowMajor;
    dom.layout.textContent = spriteRowMajor ? 'ROW' : 'COL';
    _renderTilePage();
  });

  dom.height.addEventListener('click', () => {
    spriteTall = !spriteTall;
    dom.height.textContent = spriteTall ? '32' : '24';
    tilePage = 0;
    _renderTilePage();
  });

  dom.go.addEventListener('click', () => {
    const val = parseInt(dom.offset.value.replace(/^0x/i, ''), 16);
    if (!isNaN(val) && val >= 0) { tileBaseOffset = val; tilePage = 0; _renderTilePage(); }
  });

  dom.poses.addEventListener('click', () => {
    posesMode = !posesMode;
    editPoseIdx = -1; editSlotIdx = -1;
    dom.poses._setActive(posesMode);
    dom.exportBtn.style.display = posesMode ? '' : 'none';
    if (posesMode) { spriteMode = false; dom.sprite._setActive(false); _renderPosesGrid(); }
    else _renderTilePage();
  });

  dom.exportBtn.addEventListener('click', () => {
    const lines = poseTiles.map(pose => {
      const tileLines = pose.tiles.map((b, i) => `  new Uint8Array([${_hexBytes(b)}]), // slot ${i}`).join('\n');
      return `// ${pose.label}\n[\n${tileLines}\n]`;
    }).join('\n\n');
    dom.exportText.value = lines;
    dom.exportOverlay.style.display = 'flex';
  });
  dom.exportClose.addEventListener('click', () => { dom.exportOverlay.style.display = 'none'; });

  dom.fprev.addEventListener('click', () => _jumpToOnionFrame(-1));
  dom.fnext.addEventListener('click', () => _jumpToOnionFrame(1));

  const pageUp = () => { if (tilePage > 0) { tilePage--; _renderTilePage(); } };
  const pageDown = () => {
    if (!tileRomBuffer) return;
    const rom = new Uint8Array(tileRomBuffer);
    const pageBytes = spriteMode ? SPRITES_PER_PAGE * (spriteTall ? 8 : 6) * 16 : TILES_PER_PAGE * 16;
    const totalPages = Math.ceil((rom.length - tileBaseOffset) / pageBytes);
    if (tilePage < totalPages - 1) { tilePage++; _renderTilePage(); }
  };
  dom.up.addEventListener('click', pageUp);
  dom.up.addEventListener('touchstart', (e) => { e.preventDefault(); pageUp(); }, { passive: false });
  dom.down.addEventListener('click', pageDown);
  dom.down.addEventListener('touchstart', (e) => { e.preventDefault(); pageDown(); }, { passive: false });

  // Keyboard paging while the sprites grid has focus (or always while mounted).
  dom._keyHandler = (e) => {
    if (e.key === 'ArrowDown') { pageDown(); e.stopImmediatePropagation(); }
    else if (e.key === 'ArrowUp') { pageUp(); e.stopImmediatePropagation(); }
  };
  window.addEventListener('keydown', dom._keyHandler, true);
}

function _openDefault() {
  const ff3 = ctx.getFF3Buffer();
  if (!ff3) {
    dom.grid.innerHTML = `<div style="color:#888;padding:20px;font-size:12px">ROM not loaded — pick a ROM on the title screen first.</div>`;
    return;
  }
  tileRomBuffer = ff3;
  tileBaseOffset = ONION_KNIGHT_OFFSET;
  tilePage = 0;
  spriteMode = true;
  dom.sprite._setActive(true);
  dom.layout.style.display = '';
  dom.height.style.display = '';
  dom.pal.style.display = '';
  dom.frameRow.style.display = 'flex';
  dom.flabel.textContent = 'F0 $' + ONION_KNIGHT_OFFSET.toString(16).toUpperCase();
  onionFrameIdx = 0;
  dom.offset.value = ONION_KNIGHT_OFFSET.toString(16).toUpperCase();
  poseTiles = OK_POSES.map(p => ({ label: p.label, rows: p.rows, cols: p.cols || 2, tiles: p.tiles.map(t => new Uint8Array(t)) }));
  _seedHitTilesFromROM();
  _seedWarriorPoses().then(() => {
    _renderTilePage();
  });
}

function _seedHitTilesFromROM() {
  const rom = new Uint8Array(ctx.getFF3Buffer());
  const hitBase = 0x50010 + 30 * 16;
  for (let t = 0; t < 6; t++) poseTiles[7].tiles[t] = rom.slice(hitBase + t * 16, hitBase + (t + 1) * 16);
}

async function _seedWarriorPoses() {
  try {
    const WR = await import('../../data/warrior-sprites.js');
    const wrPoses = [
      { label: 'WR IDLE',     tiles: [...WR.WR_IDLE, WR.WR_LEG_L, WR.WR_LEG_R], rows: 3 },
      { label: 'WR L BACK',   tiles: [WR.WR_L_BACK[0], WR.WR_L_BACK[1], WR.WR_L_BACK[2], WR.WR_L_BACK[3], WR.WR_LEG_L_BACK_L, WR.WR_LEG_R_BACK_L], rows: 3 },
      { label: 'WR L FWD',    tiles: [WR.WR_IDLE[0], WR.WR_IDLE[1], WR.WR_L_FWD_T2, WR.WR_L_FWD_T3, WR.WR_LEG_L_FWD_L, WR.WR_LEG_R_FWD_L], rows: 3 },
      { label: 'WR R BACK',   tiles: [WR.WR_IDLE[0], WR.WR_IDLE[1], WR.WR_R_BACK_T2, WR.WR_IDLE[3], WR.WR_LEG_L_BACK_R, WR.WR_LEG_R_SWING], rows: 3 },
      { label: 'WR R FWD',    tiles: [WR.WR_IDLE[0], WR.WR_IDLE[1], WR.WR_IDLE[2], WR.WR_IDLE[3], WR.WR_LEG_L_FWD_R, WR.WR_LEG_R_SWING], rows: 3 },
      { label: 'WR KNEEL',    tiles: [...WR.WR_KNEEL, WR.WR_LEG_L_KNEEL, WR.WR_LEG_R_KNEEL], rows: 3 },
      { label: 'WR VICTORY',  tiles: [...WR.WR_VICTORY, WR.WR_LEG_L_VICTORY, WR.WR_LEG_R_VICTORY], rows: 3 },
      { label: 'WR HIT',      tiles: [...WR.WR_HIT, WR.WR_LEG_L_HIT, WR.WR_LEG_R_HIT], rows: 3 },
      { label: 'WR DEATH',    tiles: [...WR.WR_DEATH], rows: 2, cols: 3 },
    ];
    for (const wp of wrPoses) poseTiles.push(wp);
  } catch (e) {
    console.warn('[debug/sprites] warrior pose load failed', e);
  }
}

function _decodeTileToImageData(rom, off, palette) {
  const pixels = decodeTile(rom, off);
  const img = new ImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const idx = pixels[p];
    if (palette) {
      const nes = palette[idx];
      if (nes === 0x0F) {
        img.data[p * 4] = 0; img.data[p * 4 + 1] = 0; img.data[p * 4 + 2] = 0; img.data[p * 4 + 3] = 255;
      } else {
        const rgb = NES_SYSTEM_PALETTE[nes] || [0, 0, 0];
        img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1]; img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
      }
    } else {
      const v = idx * 85;
      img.data[p * 4] = v; img.data[p * 4 + 1] = v; img.data[p * 4 + 2] = v; img.data[p * 4 + 3] = 255;
    }
  }
  return img;
}

function _renderTilePage() {
  if (!tileRomBuffer) return;
  if (posesMode) return _renderPosesGrid();
  const rom = new Uint8Array(tileRomBuffer);
  dom.grid.innerHTML = '';

  if (spriteMode) {
    const rows = spriteTall ? 4 : 3;
    const tilesPerSprite = 2 * rows;
    const sprH = rows * 8;
    const bytesPerSprite = tilesPerSprite * 16;
    const startOff = tileBaseOffset + tilePage * SPRITES_PER_PAGE * bytesPerSprite;
    const totalPages = Math.ceil((rom.length - tileBaseOffset) / (SPRITES_PER_PAGE * bytesPerSprite));
    dom.header.textContent = `SPRITE 16×${sprH}  PG ${tilePage + 1}/${totalPages}  $${startOff.toString(16).toUpperCase()}`;
    for (let i = 0; i < SPRITES_PER_PAGE; i++) {
      const sprOff = startOff + i * bytesPerSprite;
      if (sprOff + bytesPerSprite - 1 >= rom.length) break;
      const src = document.createElement('canvas');
      src.width = 16; src.height = sprH;
      const sctx = src.getContext('2d');
      for (let t = 0; t < tilesPerSprite; t++) {
        const toff = sprOff + t * 16;
        if (toff + 15 >= rom.length) break;
        const tx = spriteRowMajor ? (t % 2) * 8 : Math.floor(t / rows) * 8;
        const ty = spriteRowMajor ? Math.floor(t / 2) * 8 : (t % rows) * 8;
        sctx.putImageData(_decodeTileToImageData(rom, toff, BATTLE_PALETTES[spritePalIdx]), tx, ty);
      }
      const scaled = document.createElement('canvas');
      scaled.width = 64; scaled.height = sprH * 4;
      const ssc = scaled.getContext('2d');
      ssc.imageSmoothingEnabled = false;
      ssc.drawImage(src, 0, 0, 64, sprH * 4);
      const cell = _makeCell(scaled, sprOff, () => { dom.offset.value = sprOff.toString(16).toUpperCase(); });
      dom.grid.appendChild(cell);
    }
  } else {
    const startOff = tileBaseOffset + tilePage * TILES_PER_PAGE * 16;
    const totalPages = Math.ceil((rom.length - tileBaseOffset) / (TILES_PER_PAGE * 16));
    dom.header.textContent = `PAGE ${tilePage + 1}/${totalPages}  $${startOff.toString(16).toUpperCase()}`;
    for (let i = 0; i < TILES_PER_PAGE && startOff + i * 16 + 15 < rom.length; i++) {
      const off = startOff + i * 16;
      const src = document.createElement('canvas');
      src.width = 8; src.height = 8;
      src.getContext('2d').putImageData(_decodeTileToImageData(rom, off), 0, 0);
      const scaled = document.createElement('canvas');
      scaled.width = 32; scaled.height = 32;
      const ssc = scaled.getContext('2d');
      ssc.imageSmoothingEnabled = false;
      ssc.drawImage(src, 0, 0, 32, 32);
      const cell = _makeCell(scaled, off, () => {
        if (editPoseIdx >= 0 && editSlotIdx >= 0) {
          poseTiles[editPoseIdx].tiles[editSlotIdx] = new Uint8Array(rom.buffer, off, 16);
          editPoseIdx = -1; editSlotIdx = -1;
          posesMode = true;
          dom.poses._setActive(true);
          _renderPosesGrid();
        }
      });
      dom.grid.appendChild(cell);
    }
  }
  dom.grid.scrollTop = 0;
}

function _makeCell(canvas, off, onTap) {
  const cell = document.createElement('div');
  cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;padding:3px;border:1px solid #2a2a3a;border-radius:2px;cursor:pointer;-webkit-tap-highlight-color:transparent;';
  canvas.style.imageRendering = 'pixelated';
  cell.appendChild(canvas);
  const label = document.createElement('span');
  label.textContent = '$' + off.toString(16).toUpperCase();
  label.style.cssText = 'font-size:7px;color:#555;font-family:monospace;';
  cell.appendChild(label);
  const flash = () => {
    cell.style.borderColor = '#c8a832';
    cell.style.background = '#1a1a2e';
    setTimeout(() => { cell.style.borderColor = '#2a2a3a'; cell.style.background = ''; }, 400);
  };
  cell.addEventListener('click', () => { flash(); onTap(); });
  cell.addEventListener('touchstart', (e) => { e.preventDefault(); flash(); onTap(); }, { passive: false });
  return cell;
}

function _renderPosesGrid() {
  dom.grid.innerHTML = '';
  const isPickMode = editPoseIdx >= 0;
  dom.header.textContent = isPickMode
    ? `▶ TAP ROM TILE TO PLACE INTO ${poseTiles[editPoseIdx].label} SLOT ${editSlotIdx}`
    : 'POSES — TAP A TILE TO EDIT';
  const pal = BATTLE_PALETTES[spritePalIdx];

  for (let pi = 0; pi < poseTiles.length; pi++) {
    const pose = poseTiles[pi];
    const rows = pose.rows;
    const cols = pose.cols || 2;

    const card = document.createElement('div');
    card.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;border:1px solid #2a2a3a;border-radius:4px;';
    if (pi === editPoseIdx) card.style.borderColor = '#c8a832';

    const lbl = document.createElement('span');
    lbl.textContent = pose.label;
    lbl.style.cssText = 'color:#c8a832;font-size:7px;font-family:monospace;';
    card.appendChild(lbl);

    const grid = document.createElement('div');
    grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},32px);gap:1px;`;

    for (let t = 0; t < rows * cols; t++) {
      const bytes = pose.tiles[t];
      const tc = bytes ? _renderOneTile8x8(bytes, pal) : (() => { const c = document.createElement('canvas'); c.width = 32; c.height = 32; return c; })();
      tc.style.cssText = 'border:1px solid #333;cursor:pointer;-webkit-tap-highlight-color:transparent;image-rendering:pixelated;';
      if (pi === editPoseIdx && t === editSlotIdx) {
        tc.style.border = '2px solid #c8a832';
        tc.style.boxShadow = '0 0 6px #c8a832';
      }
      const finalPi = pi, finalT = t;
      const onPick = (e) => {
        if (e) e.preventDefault();
        editPoseIdx = finalPi; editSlotIdx = finalT;
        posesMode = false;
        dom.poses._setActive(false);
        spriteMode = false;
        dom.sprite._setActive(false);
        dom.layout.style.display = 'none';
        dom.height.style.display = 'none';
        dom.frameRow.style.display = 'none';
        dom.header.textContent = `▶ PICK TILE FOR ${poseTiles[finalPi].label} SLOT ${finalT}`;
        _renderTilePage();
      };
      tc.addEventListener('click', onPick);
      tc.addEventListener('touchstart', onPick, { passive: false });
      grid.appendChild(tc);
    }

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'BYTES';
    copyBtn.style.cssText = 'margin-top:2px;font-size:7px;font-family:monospace;padding:2px 4px;background:#1e1e2e;border:1px solid #444;color:#888;border-radius:3px;cursor:pointer;';
    const onCopy = (e) => {
      if (e) e.preventDefault();
      const lines = pose.tiles.map((b, i) => `  // slot ${i}\n  new Uint8Array([${_hexBytes(b)}]),`).join('\n');
      dom.offset.value = lines;
    };
    copyBtn.addEventListener('click', onCopy);
    copyBtn.addEventListener('touchstart', onCopy, { passive: false });
    card.appendChild(grid);
    card.appendChild(copyBtn);
    dom.grid.appendChild(card);
  }
}

function _renderOneTile8x8(bytes, pal) {
  const src = document.createElement('canvas'); src.width = 8; src.height = 8;
  src.getContext('2d').putImageData(_decodeTileToImageData(bytes, 0, pal), 0, 0);
  const scaled = document.createElement('canvas'); scaled.width = 32; scaled.height = 32;
  const sc = scaled.getContext('2d'); sc.imageSmoothingEnabled = false;
  sc.drawImage(src, 0, 0, 32, 32);
  return scaled;
}

function _hexBytes(arr) {
  return Array.from(arr).map(x => '0x' + x.toString(16).toUpperCase().padStart(2, '0')).join(',');
}

function _jumpToOnionFrame(delta) {
  if (!tileRomBuffer) return;
  const rom = new Uint8Array(tileRomBuffer);
  onionFrameIdx = Math.max(0, onionFrameIdx + delta);
  tileBaseOffset = ONION_KNIGHT_OFFSET + onionFrameIdx * ONION_FRAME_STEP;
  if (tileBaseOffset >= rom.length) {
    onionFrameIdx = Math.max(0, onionFrameIdx - delta);
    tileBaseOffset = ONION_KNIGHT_OFFSET + onionFrameIdx * ONION_FRAME_STEP;
  }
  tilePage = 0;
  dom.flabel.textContent = 'F' + onionFrameIdx + ' $' + tileBaseOffset.toString(16).toUpperCase();
  dom.offset.value = tileBaseOffset.toString(16).toUpperCase();
  _renderTilePage();
}
