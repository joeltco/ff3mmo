// Shared save codec. No DOM or player state; used by client and server.
import { MINES_DESIGN } from './definitions/mines.js';

export function sanitizeDungeonRun(value) {
  if (!value || value.dungeonId !== MINES_DESIGN.id || value.version !== MINES_DESIGN.version
      || !Number.isSafeInteger(value.seed) || value.seed < 0) return null;
  const features = {};
  for (const id of MINES_DESIGN.featureIds) if (value.features?.[id] === 1) features[id] = 1;
  return { dungeonId: value.dungeonId, version: value.version, seed: value.seed, features };
}

export function startOrResumeDungeonRun(previous, dungeon, seed) {
  if (!dungeon.design) return null;
  const saved = sanitizeDungeonRun(previous);
  // Reaching the end with a full bag must not discard the unclaimed cache.
  const finished = saved?.features['end-working'] && dungeon.design.rewardIds.every(id => saved.features[id]);
  if (saved && saved.dungeonId === dungeon.id && !finished) return saved;
  return { dungeonId: dungeon.id, version: dungeon.design.version, seed, features: {} };
}
