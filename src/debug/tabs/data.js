// DATA tab — ROM-extracted tables (items, monsters, spells, jobs, encounters, shops). Stub.

export function mount(root /* , ctx */) {
  const msg = document.createElement('div');
  msg.style.cssText = 'padding:16px;color:#888;font-size:12px;line-height:1.6;';
  msg.innerHTML = `
    <div style="color:#c8a832;font-size:11px;margin-bottom:8px">DATA — not implemented</div>
    Planned: searchable tables for ITEMS, MONSTERS, SPELLS, JOBS, ENCOUNTERS, SHOPS.
    Row click → "give to me" / "spawn in battle" / "equip now".`;
  root.appendChild(msg);
}

export function unmount() {}
