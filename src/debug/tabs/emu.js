// EMU tab — jsnes-backed PPU capture / recipe runner. Stub for now.

export function mount(root /* , ctx */) {
  const msg = document.createElement('div');
  msg.style.cssText = 'padding:16px;color:#888;font-size:12px;line-height:1.6;';
  msg.innerHTML = `
    <div style="color:#c8a832;font-size:11px;margin-bottom:8px">EMU — not implemented</div>
    Planned: jsnes-backed NES emulator with recipe runner for PPU $1000 / OAM / palette capture.
    Each recipe is a JS file in <code>src/debug/recipes/</code> exporting { label, run(emu) }.
    Runner drives the emulator via scripted input, waits on OAM predicates, then dumps ready-to-paste Uint8Array literals.`;
  root.appendChild(msg);
}

export function unmount() {}
