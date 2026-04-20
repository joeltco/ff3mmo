// LOG tab — live event stream from the debug bus. Stub for now, will enable bus on mount.

import { enable, disable, subscribe, snapshot, isEnabled } from '../bus.js';

let unsubscribe = null;

export function mount(root /* , ctx */) {
  if (!isEnabled()) enable();

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;';

  const head = document.createElement('div');
  head.style.cssText = 'color:#c8a832;font-size:11px;padding:4px 8px;border-bottom:1px solid #333;';
  head.textContent = 'LOG — event bus (ring buffer)';
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.style.cssText = 'flex:1;overflow:auto;padding:4px 8px;font-size:11px;line-height:1.4;';
  wrap.appendChild(list);

  const render = (entry) => {
    const row = document.createElement('div');
    row.style.cssText = 'white-space:pre;color:#bbb;';
    const t = (entry.t | 0).toString().padStart(7, ' ');
    const payload = entry.payload === undefined ? '' : ' ' + JSON.stringify(entry.payload);
    row.textContent = `${t}ms  ${entry.type}${payload}`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  };

  for (const e of snapshot()) render(e);
  unsubscribe = subscribe(render);

  root.appendChild(wrap);
}

export function unmount() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  // Leave bus enabled — instrumentation writes are free, and re-opening the tab should show history.
}
