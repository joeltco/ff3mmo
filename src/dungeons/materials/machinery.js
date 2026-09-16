// Native Owen material, inspected from maps 128/130 and their tile sheet.
// Structural shell is fixed; machine banks and service walks occupy its inside.
// No cave overhang pass: the route is already the finished walkable surface.
export function paintMachinery(route) {
  const tm = new Uint8Array(1024).fill(0x5f);
  const [left, top, right, bottom] = route.shell;
  for (let y = top - 3; y <= bottom + 1; y++) for (let x = left - 1; x <= right + 1; x++) {
    const boundary = x === left - 1 || x === right + 1 || y === top - 3 || y === bottom + 1;
    tm[y * 32 + x] = boundary ? 0x00 : y < top ? 0x14 : 0x1b;
  }
  if (route.id === 'shaft' || route.id === 'engine') {
    // Native suspended mechanisms are solid scenery, not walkable "cover".
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      tm[y * 32 + x] = y % 2 ? (x % 3 === 0 ? 0x17 : 0x1a) : (x % 3 === 0 ? 0x18 : 0x5f);
    }
  }
  for (const [x, y] of route.floorCells) tm[y * 32 + x] = 0x30;
  for (const bank of route.banks) for (const [x0, y0, x1, y1] of bank.columns) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tm[y * 32 + x] = y === y0 ? 0x02 : 0x14;
  }
  // Gear faced from the upper service lane, integrated into the cross-bank.
  for (const f of route.features) if (f.kind === 'passage') tm[f.at[1] * 32 + f.at[0]] = 0x02;
  if (route.warpTile) tm[route.warpTile.y * 32 + route.warpTile.x] = 0x61;
  return tm;
}
