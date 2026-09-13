// Paint the native mine material around an already defined excavation route.
export function paintMineRoute(route) {
  const tilemap = new Uint8Array(1024);
  const carve = ([left, top, right, bottom]) => {
    if (![left, top, right, bottom].every(Number.isInteger) || left > right || top > bottom || left < 1 || right > 30 || top < 3 || bottom > 29) throw new Error('Room exceeds map bounds');
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) tilemap[y * 32 + x] = 0x30;
  };
  const roomIds = new Set(route.rooms.map(r => r.id));
  for (const room of route.rooms) carve(room.rect);
  for (const link of route.links) {
    if (!roomIds.has(link.from) || !roomIds.has(link.to)) throw new Error('Unresolved room link');
    for (const rect of link.rects) carve(rect);
  }
  // Mine material profile: native two-tile rocky faces above excavated ground.
  // Painting cannot change the walkable route defined above.
  const floorMask = tilemap.slice();
  for (let y = 3; y < 30; y++) for (let x = 1; x < 31; x++) {
    const i = y * 32 + x;
    if (floorMask[i] !== 0x30 || floorMask[i - 32] !== 0) continue;
    if (floorMask[i - 64] !== 0) throw new Error('Mine galleries need a two-tile wall clearance');
    tilemap[i - 32] = 1; tilemap[i - 64] = 1;
  }
  return tilemap;
}
