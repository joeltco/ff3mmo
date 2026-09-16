// Five authored floors, using native Owen maps 126/128/130/132/134.
export const OWEN_DESIGN = {
  id: 'owen', version: 1, layout: 'authored-machinery', material: 'machinery',
  floors: ['machine-gallery', 'distribution', 'shaft', 'control', 'engine'],
  entryAnchor: { world: { x: 63, y: 32 } },
  variants: [4, 4, 3, 4, 1],
  featureIds: ['power-bank', 'gallery-cache', 'distribution-power', 'distribution-cache', 'shaft-cache', 'control-power', 'control-cache'],
};
export function planOwen(floor, seed) {
  if (!Number.isInteger(floor) || floor < 0 || floor > 4) throw new Error(`Owen has no floor ${floor}`);
  const variant = (seed >>> 0) % 4;
  const cells = new Set();
  const rect = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.add(`${x},${y}`);
  };
  const remove = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.delete(`${x},${y}`);
  };
  const shell = [1, 3, 14, 12];
  const entrance = floor === 4 ? [13, 8] : [13, 4], exit = floor === 4 ? [1, 8] : [1, 10];
  if (floor === 1) entrance[0] = 14;
  let banks = [], features;
  if (floor === 0 || floor === 1) {
    rect(...shell);
    const a = 4 + (variant & 1), b = 9 - (variant >> 1);
    banks = [a, b].map((x, index) => ({ id: `bank-${index}`, rect: [x - 1, 4, x + 2, 7],
      columns: [[x, 5, x + 1, 6]], entry: [x, 4], exit: [x, 7] }));
    if (floor === 1) {
      const x = 3 + (variant & 1), right = 10 - (variant >> 1);
      banks = [
        { id: 'distribution-cross-bank', rect: [x - 1, 4, x + 4, 7],
          columns: [[x, 5, x + 3, 6]], entry: [x - 1, 5], exit: [x + 4, 5] },
        { id: 'distribution-upright', rect: [right - 1, 4, right + 2, 7],
          columns: [[right, 5, right + 1, 6]], entry: [right, 4], exit: [right, 7] },
      ];
    }
    for (const bank of banks) for (const column of bank.columns) remove(...column);
    if (floor === 0) remove(7, 9, 8, 11);
    remove(4, 9, 5, 11); remove(9, 9, 10, 11);
    if (floor === 1) rect(4, 9, 5, 10);
    // A transverse machine bank makes the right-side cache a real detour.
    // Power opens a service gate; it never closes or moves existing floor.
    remove(3, 8, 14, 8);
    features = [
      { id: 'power-bank', kind: 'passage', at: [7 + (variant & 1), 8], openingOnly: true,
        pages: ['Release the service gate.', 'The right lane opens.'],
        tiles: [12, 13].map(x => ({x, y: 8, tile: 0x30})) },
      { id: 'gallery-cache', kind: 'chest', at: [14, 12] },
    ];
  } else if (floor === 2) {
    // The same shell, largely occupied by the shaft. Three narrow perimeter
    // walks and one service spur; the arrival is a proper 3x3 landing.
    rect(1, 3, 14, 3); rect(1, 3, 1, 12); rect(1, 12, 14, 12);
    rect(12, 3, 14, 5);
    const tip = 4 + (variant % 3);
    rect(1, 7, tip, 7);
    features = [{ id: 'shaft-cache', kind: 'chest', at: [tip, 7] }];
  } else if (floor === 3) {
    rect(1, 3, 14, 5); rect(1, 6, 2, 12); rect(3, 10, 14, 12);
    remove(3, 11, 13, 11); remove(3, 12, 13, 12); rect(3, 12, 8, 12);
    const x = 5 + (variant & 1);
    banks = [{ id: 'regulator-bank', rect: [x - 1, 3, x + 2, 5],
      columns: [[x, 4, x + 1, 4]], entry: [x, 3], exit: [x, 5] }];
    remove(x, 4, x + 1, 4);
    // A switch on the upper gallery opens an additional right service lane.
    features = [
      { id: 'control-power', kind: 'passage', at: [8 + (variant >> 1), 6], openingOnly: true,
        pages: ['Release the regulator gate.', 'The service lane opens.'],
        tiles: [6, 7, 8, 9].map(y => ({ x: 14, y, tile: 0x30 })) },
      { id: 'control-cache', kind: 'chest', at: [14, 12] },
    ];
  } else {
    // Eighteen walking tiles inside the same building. Medusa remains at
    // (6,8); the existing boss-gated warp is on the far side of her.
    rect(1, 8, 13, 8); rect(12, 7, 13, 7);
    rect(1, 9, 1, 9); rect(6, 7, 6, 7); rect(6, 9, 6, 9);
    features = [];
  }
  if (floor === 1) features = features.map(f => ({ ...f,
    id: f.id === 'power-bank' ? 'distribution-power' : 'distribution-cache' }));

  return {
    id: OWEN_DESIGN.floors[floor], name: ['Machine Gallery', 'Power Distribution', 'Shaft Crossing', 'Control Gallery', 'Engine Room'][floor],
    topology: ['machine-banks', 'machine-banks', 'perimeter-shaft', 'regulator-galleries', 'engine-chamber'][floor], shell, entrance, exit,
    floorCells: [...cells].map(key => key.split(',').map(Number)), banks, variant,
    rooms: [{ id: 'tower-envelope', kind: 'machinery', rect: shell }], links: [],
    ports: [
      { id: 'arrival', at: entrance, destination: floor === 0 ? {goBack: true} : {floor: floor - 1, destX: 1, destY: 10}, role: 'arrival' },
      ...(floor < 4 ? [{ id: 'onward', at: exit, destination: {floor: floor + 1}, role: 'objective' }] : []),
    ], features, warpTile: floor === 4 ? { x: exit[0], y: exit[1] } : null,
  };
}
