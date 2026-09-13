// An excavation, not a cave algorithm with a different palette. Rectangles
// describe finished walkable ground; links describe the actual route first.
export const MINES_DESIGN = {
  id: 'mines', version: 1, layout: 'authored-mine', material: 'mine-rock', floors: ['workings', 'deep-seam'],
  entryAnchor: { mapId: 10, x: 21, y: 12 }, retiredMapIds: [12002],
  featureIds: ['supply-cache', 'old-face', 'tool-cache', 'sword-cache', 'end-working'],
  rewardIds: ['sword-cache', 'tool-cache'],
};

export function planMines(floor, seed) {
  const variant = ((seed >>> 0) % 3);
  if (floor === 0) {
    const branchEnd = 13 + variant * 2;
    return {
      id: 'workings', name: 'Old Workings', entrance: [5, 26],
      rooms: [
        { id: 'mouth', rect: [4, 22, 7, 27] },
        { id: 'crosscut', rect: [4, 15, 9, 18] },
        { id: 'supply-bay', rect: [branchEnd - 2, 15, branchEnd, 18] },
        { id: 'old-face', rect: [21, 9, 25, 12] },
      ],
      links: [
        { from: 'mouth', to: 'crosscut', rects: [[5, 18, 6, 22]] },
        { from: 'crosscut', to: 'supply-bay', rects: [[9, 16, branchEnd - 2, 17]] },
        { from: 'crosscut', to: 'old-face', rects: [[7, 10, 8, 15], [8, 10, 21, 11]] },
      ],
      ports: [{ id: 'entrance', at: [5, 26], destination: { goBack: true } }],
      features: [
        { id: 'supply-cache', kind: 'chest', at: [branchEnd, 15] },
        { id: 'old-face', kind: 'passage', at: [23, 8],
          pages: ['A hollow sound...', 'An old stair lies beyond.'],
          tiles: [{ x: 23, y: 7, tile: 0x42 }, { x: 23, y: 8, tile: 0x73 }],
          port: { id: 'deep-stair', at: [23, 8], destination: { floor: 1 } } },
      ],
    };
  }
  if (floor !== 1) throw new Error(`Unknown Mines section ${floor}`);
  const bayLeft = 3 + variant;
  return {
    id: 'deep-seam', name: 'Hidden Working', entrance: [5, 26],
    rooms: [
      { id: 'stair-landing', rect: [4, 23, 7, 27] },
      { id: 'tool-bay', rect: [bayLeft, 14, 8, 17] },
      { id: 'turning', rect: [18, 14, 22, 17] },
      { id: 'end-working', rect: [19, 5, 25, 8] },
    ],
    links: [
      { from: 'stair-landing', to: 'tool-bay', rects: [[5, 17, 6, 23]] },
      { from: 'tool-bay', to: 'turning', rects: [[8, 15, 18, 16]] },
      { from: 'turning', to: 'end-working', rects: [[20, 8, 21, 14]] },
    ],
    ports: [{ id: 'entrance', at: [5, 26], destination: { goBack: true } }],
    features: [
      { id: 'tool-cache', kind: 'chest', at: [bayLeft, 14], item: 0x64 },
      { id: 'sword-cache', kind: 'chest', at: [25, 5], item: 0x27 },
      { id: 'end-working', kind: 'landmark', at: [20, 8], area: [19, 5, 25, 8], flag: 'mines_explored',
        pages: ['The hidden working!', 'Mythril was stored here.', 'The mine is explored.', 'Return by the old stair.'] },
    ],
  };
}
