// Debug panel: tabbed overlay for dev tools.
// Access: konami code, ?debug=1 URL param, or ~ key. Gated by canDebug().

const TAB_DEFS = [
  { id: 'sprites', label: 'SPRITES', loader: () => import('./tabs/sprites.js') },
  { id: 'emu',     label: 'EMU',     loader: () => import('./tabs/emu.js') },
  { id: 'data',    label: 'DATA',    loader: () => import('./tabs/data.js') },
  { id: 'state',   label: 'STATE',   loader: () => import('./tabs/state.js') },
  { id: 'log',     label: 'LOG',     loader: () => import('./tabs/log.js') },
  { id: 'perf',    label: 'PERF',    loader: () => import('./tabs/perf.js') },
];

let overlay = null;
let tabHost = null;
let currentTab = null;
let currentTabModule = null;
let isOpen = false;
let context = null;

export function canDebug() {
  return sessionStorage.getItem('ff3_auth') === '1';
}

export function initDebugPanel(ctx) {
  context = ctx;
  _installTriggers();
  if (new URLSearchParams(location.search).get('debug') === '1' && canDebug()) {
    open();
  }
}

export function open() {
  if (isOpen) return;
  if (!canDebug()) return;
  if (!overlay) _buildOverlay();
  overlay.style.display = 'flex';
  isOpen = true;
  if (!currentTab) _switchTab('sprites');
}

export function close() {
  if (!isOpen) return;
  if (currentTabModule?.unmount) {
    try { currentTabModule.unmount(); } catch (e) { console.error('[debug] unmount failed', e); }
  }
  currentTabModule = null;
  currentTab = null;
  overlay.style.display = 'none';
  isOpen = false;
}

export function isPanelOpen() {
  return isOpen;
}

function _buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'debug-panel';
  overlay.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0a10;
    display:none;flex-direction:column;z-index:500;padding:6px;box-sizing:border-box;
    font-family:monospace;color:#e0e0e0;`;

  const header = document.createElement('div');
  header.style.cssText = `display:flex;align-items:center;gap:4px;border-bottom:1px solid #333;padding-bottom:4px;margin-bottom:6px;flex-shrink:0;`;

  for (const def of TAB_DEFS) {
    const btn = document.createElement('button');
    btn.dataset.tabId = def.id;
    btn.textContent = def.label;
    btn.style.cssText = `padding:5px 10px;background:#1e1e2e;border:1px solid #444;border-radius:4px;color:#888;font-family:monospace;font-size:11px;cursor:pointer;`;
    btn.addEventListener('click', () => _switchTab(def.id));
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); _switchTab(def.id); }, { passive: false });
    header.appendChild(btn);
  }

  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1';
  header.appendChild(spacer);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'X';
  closeBtn.style.cssText = `width:36px;height:28px;background:#1e1e2e;border:1px solid #666;border-radius:4px;color:#c8a832;font-family:monospace;font-size:13px;cursor:pointer;`;
  closeBtn.addEventListener('click', close);
  closeBtn.addEventListener('touchstart', (e) => { e.preventDefault(); close(); }, { passive: false });
  header.appendChild(closeBtn);

  overlay.appendChild(header);

  tabHost = document.createElement('div');
  tabHost.id = 'debug-tab-host';
  tabHost.style.cssText = `flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;`;
  overlay.appendChild(tabHost);

  document.body.appendChild(overlay);
}

async function _switchTab(tabId) {
  if (tabId === currentTab) return;
  if (currentTabModule?.unmount) {
    try { currentTabModule.unmount(); } catch (e) { console.error('[debug] unmount failed', e); }
  }
  currentTabModule = null;
  tabHost.innerHTML = '';

  for (const b of overlay.querySelectorAll('button[data-tab-id]')) {
    b.style.borderColor = b.dataset.tabId === tabId ? '#c8a832' : '#444';
    b.style.color = b.dataset.tabId === tabId ? '#c8a832' : '#888';
  }
  currentTab = tabId;

  const def = TAB_DEFS.find(d => d.id === tabId);
  try {
    const mod = await def.loader();
    currentTabModule = mod;
    if (mod.mount) mod.mount(tabHost, context);
  } catch (e) {
    tabHost.innerHTML = `<div style="color:#f66;padding:12px;font-size:12px">Failed to load tab "${tabId}": ${e.message}</div>`;
    console.error('[debug] tab load failed', e);
  }
}

function _installTriggers() {
  const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','x','z','Enter'];
  let idx = 0;
  window.addEventListener('keydown', (e) => {
    if (isOpen) return;
    if (e.key === KONAMI[idx]) {
      idx++;
      if (idx === KONAMI.length) { idx = 0; open(); }
    } else {
      idx = e.key === KONAMI[0] ? 1 : 0;
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') {
      if (!isOpen && canDebug()) { e.preventDefault(); open(); }
    } else if (isOpen && e.key === 'Escape') {
      e.preventDefault(); close();
    }
  }, true);
}
