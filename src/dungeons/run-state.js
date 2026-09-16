// Shared save codec. No DOM or player state; used by client and server.
import { OWEN_DESIGN } from './definitions/owen.js';
import { MINES_DESIGN } from './definitions/mines.js';

export function sanitizeDungeonRun(value) {
  const design = [MINES_DESIGN, OWEN_DESIGN].find(d => d.id === value?.dungeonId);
  if (!design || value.version !== design.version
      || !Number.isSafeInteger(value.seed) || value.seed < 0) return null;
  const features = {};
  for (const id of design.featureIds) if (value.features?.[id] === 1) features[id] = 1;
  return { dungeonId: value.dungeonId, version: value.version, seed: value.seed, features };
}

export function startOrResumeDungeonRun(previous, dungeon, seed) {
  if (!dungeon.design) return null;
  const saved = sanitizeDungeonRun(previous);
  // Reaching the end with a full bag must not discard the unclaimed cache.
  const finished = saved?.features['end-working'] && dungeon.design.rewardIds?.every(id => saved.features[id]);
  if (saved && saved.dungeonId === dungeon.id && !finished) return saved;
  return { dungeonId: dungeon.id, version: dungeon.design.version, seed, features: {} };
}
