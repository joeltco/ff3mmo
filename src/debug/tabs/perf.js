// PERF tab — frame time, memory, timers. Stub.

export function mount(root /* , ctx */) {
  const msg = document.createElement('div');
  msg.style.cssText = 'padding:16px;color:#888;font-size:12px;line-height:1.6;';
  msg.innerHTML = `
    <div style="color:#c8a832;font-size:11px;margin-bottom:8px">PERF — not implemented</div>
    Planned: frame time histogram, ROM/IndexedDB sizes, active timers/intervals.`;
  root.appendChild(msg);
}

export function unmount() {}
