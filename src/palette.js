// NES palette fade utilities

// Fade one NES color one step toward black ($0F)
export function nesColorFade(c) {
  if (c === 0x0F) return 0x0F;
  const hi = c & 0x30;
  if (hi === 0) return 0x0F;
  return (hi - 0x10) | (c & 0x0F);
}

// Build a [black, black, black, white] palette faded N steps toward black
export function _makeFadedPal(fadeStep) {
  const p = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) p[3] = nesColorFade(p[3]);
  return p;
}

// Fade palette colors 1-3 one step in place
export function _stepPalFade(pal) {
  pal[1] = nesColorFade(pal[1]); pal[2] = nesColorFade(pal[2]); pal[3] = nesColorFade(pal[3]);
}
