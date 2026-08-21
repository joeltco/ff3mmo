// Floor plans — what a floor is made of, recorded as it is built.
//
// Phase 2 of docs/DUNGEON-CHAMBERS-PLAN.md. Today a floor's structure exists
// only as the side effects of a long branch: you cannot ask "what chambers does
// floor 1 have and how are they joined" without re-reading the carve code. A
// plan makes that a value.
//
// ⛔ THE PLAN IS RECORDED WHILE CARVING, NOT BUILT AND THEN RENDERED.
// The obvious design — describe the whole floor, then render it — REORDERS THE
// RNG DRAWS and changes every floor. A floor draws from one seeded stream, and
// today the draws that size a corridor are interleaved with the draws that
// jitter a chamber's edges: chamber, then corridor length, then chamber, then
// corridor length. Build-then-render would move all the sizing draws in front of
// all the jitter draws. So `planChamber` and friends carve immediately and
// record what they carved. Byte-identical by construction, and the plan is still
// a value you can print, diff and — in phase 3 — generate instead of transcribe.
//
// ⛔ COVERAGE IS PARTIAL AND THE PLAN SAYS SO. Floor 0's shape comes from a
// traced ceiling snake and floor 3's rooms are still carved inline, so their
// plans record only part of what is on the map. `complete: false` marks that;
// do not read an incomplete plan as "this is the whole floor".

import { carveChamber, carveWideChamber, carveBoxChamber, carveOrganicRoom } from './chambers.js';
import { carveHRun, carveVRun, carveFatteningVRun, carveFatteningHRun } from './corridors.js';

/** @param {boolean} complete — does this plan record EVERY chamber on the floor? */
export function createPlan(floorIndex, complete = false) {
  return { floorIndex, complete, chambers: [], links: [] };
}

/** Carve a jittered room and record it. */
export function planChamber(plan, tilemap, rng, role, spec) {
  carveChamber(tilemap, rng, spec);
  plan.chambers.push({ role, kind: 'room', ...spec });
  return spec;
}

/** Carve a wide, heavily-jittered chamber and record it. */
export function planWideChamber(plan, tilemap, rng, role, spec) {
  carveWideChamber(tilemap, rng, spec);
  const { keepClear, ...rest } = spec;          // a predicate is not plan data
  plan.chambers.push({ role, kind: 'wide', keepClear: !!keepClear, ...rest });
  return spec;
}

/** Carve an unjittered box room and record it. */
export function planBoxChamber(plan, tilemap, role, spec) {
  carveBoxChamber(tilemap, spec);
  plan.chambers.push({ role, kind: 'box', ...spec });
  return spec;
}

/** Carve an organic room (column-span form) and record it. */
export function planOrganicRoom(plan, tilemap, rng, role, spec) {
  carveOrganicRoom(tilemap, rng, spec);
  const { keepEdge, ...rest } = spec;          // a predicate is not plan data
  plan.chambers.push({ role, kind: 'organic', keepEdge: !!keepEdge, ...rest });
  return spec;
}

/** Carve a horizontal corridor and record it. */
export function planHLink(plan, tilemap, spec) {
  const r = carveHRun(tilemap, spec);
  plan.links.push({ kind: 'h', ...spec, endX: r.endX });
  return r;
}

/** Carve a vertical corridor and record it. */
export function planVLink(plan, tilemap, spec) {
  const r = carveVRun(tilemap, spec);
  plan.links.push({ kind: 'v', ...spec, endY: r.endY });
  return r;
}

/** Carve the width-varying vertical spine and record it. */
export function planSpine(plan, tilemap, rng, spec) {
  carveFatteningVRun(tilemap, rng, spec);
  plan.links.push({ kind: 'spine', ...spec });
}

/** Carve a fattening horizontal branch and record it. */
export function planBranch(plan, tilemap, rng, spec) {
  const r = carveFatteningHRun(tilemap, rng, spec);
  const { stopAt, ...rest } = spec;
  plan.links.push({ kind: 'branch', ...rest, endX: r.endX });
  return r;
}

/** Record something carved by code that has not been folded into a primitive. */
export function planNote(plan, role, note) {
  plan.chambers.push({ role, kind: 'inline', note });
}

/** One-line-per-entry summary, for tools and debugging. */
export function describePlan(plan) {
  const out = [`floor ${plan.floorIndex} — ${plan.chambers.length} chamber(s), ${plan.links.length} link(s)${plan.complete ? '' : '  [PARTIAL — some carves are still inline]'}`];
  for (const c of plan.chambers) {
    out.push(c.kind === 'inline'
      ? `  chamber ${c.role.padEnd(10)} inline    ${c.note}`
      : c.kind === 'organic'
      ? `  chamber ${c.role.padEnd(10)} organic cols ${c.left}..${c.right} rows ${c.top}..${c.bot}${c.keepEdge ? ' (edge held)' : ''}`
      : `  chamber ${c.role.padEnd(10)} ${String(c.kind).padEnd(6)} at ${c.x},${c.y}` +
        (c.dir ? ` dir ${c.dir > 0 ? '+' : '-'}` : '') +
        (c.w != null ? ` w${c.w}` : '') + (c.dyMin != null ? ` rows ${c.dyMin}..${c.dyMax}` : ''));
  }
  for (const l of plan.links) {
    out.push(l.kind === 'h' || l.kind === 'branch'
      ? `  link    ${l.kind.padEnd(10)} from ${l.x0},${l.y} dir ${l.dir > 0 ? '+' : '-'} steps ${l.steps} -> x${l.endX}`
      : l.kind === 'v'
        ? `  link    v          from ${l.x},${l.y0} dir ${l.dir > 0 ? 'down' : 'up'} steps ${l.steps} -> y${l.endY}`
        : `  link    spine      col ${l.x} rows ${l.yFrom}..${l.yTo}`);
  }
  return out.join('\n');
}
