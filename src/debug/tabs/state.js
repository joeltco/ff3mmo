// STATE tab — live game state editor (player, battle, map, saves). Stub.

export function mount(root /* , ctx */) {
  const msg = document.createElement('div');
  msg.style.cssText = 'padding:16px;color:#888;font-size:12px;line-height:1.6;';
  msg.innerHTML = `
    <div style="color:#c8a832;font-size:11px;margin-bottom:8px">STATE — not implemented</div>
    Planned: live edit player (jobIdx, level, HP/MP, stats, status bitmask, gil, CP/JP,
    inventory, equipped items, lastTown), battle (monster HP sliders, inflict status,
    force crit, skip turn), map (teleport, spawn encounter, trigger chest).`;
  root.appendChild(msg);
}

export function unmount() {}
