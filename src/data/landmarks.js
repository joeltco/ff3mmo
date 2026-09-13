// Named outdoor destinations. Kept outside the town registry so mountain
// treasure does not acquire town respawn rules or become a town respawn point.
import { encodeName } from './strings.js';

export const LANDMARKS = new Map([
  [92, { name: 'Summit Road', loc: 'summit-road' }],
  [185, { name: 'Healing Copse', loc: 'healing-copse' }],
]);
export const LANDMARK_BANNERS = new Map(
  [...LANDMARKS].map(([id, place]) => [id, encodeName(place.name)]),
);
