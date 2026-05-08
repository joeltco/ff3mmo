// tools/classify-spell-phases.js
// Mechanical phase classification of a parsed REC OAM dump.
// Zero interpretation — applies fixed rules to (frame, group, origin, palette,
// tile-id) tuples and emits a JSON summary of cast / projectile / impact /
// scorch / popup phases. The user verifies the JSON before any code uses it.
//
// Rules used (all derived from CLAUDE.md + memory):
//   - Party is on the RIGHT (x ≥ 160). Enemy is on the LEFT (x ≤ 128).
//   - Caster body = persistent group on party side, present from frame 0.
//   - Cast halo = SP3 palette swaps to a non-default value while caster body
//                 is the only group; cast frames = [0, lastCastFrame].
//   - Projectile = group whose origin (x or y) changes monotonically frame-
//                  to-frame. (Often BG-tile, so may not appear in OAM dump.)
//   - Impact = group at enemy-side x that appears AFTER cast end, lasts
//              several frames, SP3 may swap to impact palette.
//   - Scorch / trailing = enemy-side group with FEWER tiles than impact,
//                         appearing AFTER impact.
//   - Damage popup = enemy-side group whose tile IDs are in [$56, $5F]
//                    (FF3-J battle digit sprites, per CLAUDE.md).
//
// usage: node tools/classify-spell-phases.js <dump.txt> [--out out.json]

import fs from 'node:fs';
import path from 'node:path';

const PARTY_X_MIN = 160;
const ENEMY_X_MAX = 128;
const DIGIT_TILE_MIN = 0x56;
const DIGIT_TILE_MAX = 0x5F;

// Reuse the parser from render-oam-dump.js by inlining a copy. Keeps the tool
// self-contained — phase classification doesn't need the renderer's PNG path.
function parseDump(text) {
  const lines = text.split('\n');
  const frames = [];
  let cur = null, curGroup = null, pendingTile = null;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fHdr = ln.match(/^\/\/ ═══ frame (\d+) \(snap @ f(\d+), t≈(-?\d+)ms\)/);
    if (fHdr) {
      if (cur) frames.push(cur);
      cur = {
        frameIdx: Number(fHdr[1]),
        frameNum: Number(fHdr[2]),
        tMs: Number(fHdr[3]),
        palettes: { bg: [[15,15,15,15],[15,15,15,15],[15,15,15,15],[15,15,15,15]],
                    sp: [[15,15,15,15],[15,15,15,15],[15,15,15,15],[15,15,15,15]] },
        groups: [],
      };
      curGroup = null; pendingTile = null;
      continue;
    }
    if (!cur) continue;

    const palHdr = ln.match(/^\/\/\s+(BG|SP)([0-3]):\s*\[([^\]]+)\]/);
    if (palHdr) {
      const which = palHdr[1] === 'BG' ? 'bg' : 'sp';
      const idx = Number(palHdr[2]);
      const vals = palHdr[3].split(',').map(s => parseInt(s.trim(), 16));
      cur.palettes[which][idx] = vals;
      continue;
    }
    const gHdr = ln.match(/^\/\/ ── group (\d+) \(\d+ tiles, origin (-?\d+),(-?\d+)\) ──/);
    if (gHdr) {
      curGroup = { origin: [Number(gHdr[2]), Number(gHdr[3])], tiles: [] };
      cur.groups.push(curGroup);
      pendingTile = null;
      continue;
    }
    if (!curGroup) continue;
    const tHdr = ln.match(/^\/\/\s+\[(-?\d+),(-?\d+)\] tile=\$([0-9A-Fa-f]+) pal(\d)( VFLIP)?( HFLIP)?/);
    if (tHdr) {
      pendingTile = {
        dx: Number(tHdr[1]), dy: Number(tHdr[2]),
        id: parseInt(tHdr[3], 16), pal: Number(tHdr[4]),
        vflip: !!tHdr[5], hflip: !!tHdr[6], bytes: null,
      };
      continue;
    }
    const tBytes = ln.match(/new Uint8Array\(\[([^\]]+)\]\)/);
    if (tBytes && pendingTile) {
      pendingTile.bytes = tBytes[1].split(',').map(s => parseInt(s.trim(), 16));
      curGroup.tiles.push(pendingTile);
      pendingTile = null;
    }
  }
  if (cur) frames.push(cur);
  return frames;
}

// ── Group classification helpers ────────────────────────────────────────────

function isPartySide(group) { return group.origin[0] >= PARTY_X_MIN; }
function isEnemySide(group) { return group.origin[0] <= ENEMY_X_MAX; }

function isDigitGroup(group) {
  // A damage popup is mostly digit tiles ($56-$5F) AND has 3+ tiles (a single
  // tile happening to land in the digit range — common for projectile sprites
  // that share CHR slots — must NOT count as a popup).
  if (group.tiles.length < 3) return false;
  const digits = group.tiles.filter(t => t.id >= DIGIT_TILE_MIN && t.id <= DIGIT_TILE_MAX).length;
  return digits / group.tiles.length >= 0.5;
}

const MONSTER_ROW_Y_MIN = 40;
const MONSTER_ROW_Y_MAX = 60;
function isMonsterRowOrigin(origin) {
  return origin[1] >= MONSTER_ROW_Y_MIN && origin[1] <= MONSTER_ROW_Y_MAX;
}

// Two groups in different frames are "the same group across time" if their
// origins are within a small jump and their tile-id sets overlap. Used to
// trace a moving projectile or a persistent caster body.
function groupsLikelyEqual(a, b) {
  const dx = Math.abs(a.origin[0] - b.origin[0]);
  const dy = Math.abs(a.origin[1] - b.origin[1]);
  if (dx > 64 || dy > 64) return false;
  const aIds = new Set(a.tiles.map(t => t.id));
  const bIds = new Set(b.tiles.map(t => t.id));
  let overlap = 0;
  for (const id of aIds) if (bIds.has(id)) overlap++;
  return overlap >= Math.min(aIds.size, bIds.size) * 0.4;
}

function paletteKey(p) { return p.join(','); }

// ── Phase detection ─────────────────────────────────────────────────────────

function classifyPhases(frames) {
  // Phase detection by frame ORDER, not tile-count. Rules:
  //   - Cast = frames where every non-popup group is at party side (x >= 160).
  //   - Projectile = run of frames where a small (≤4 tile) group has a
  //                  moving origin crossing toward enemy side. Often party-
  //                  side at first (caster's wand-spark), then mid-screen.
  //   - Impact = first enemy-side non-popup group whose origin is NOT at the
  //              monster-row y range — this is the spell-on-target burst.
  //   - Scorch = enemy-side non-popup group(s) appearing AFTER impact ends,
  //              at a different origin or smaller tile count.
  //   - Death-wipe = late-frame enemy-side group at monster-row y (40-60),
  //                  distinct from impact (which is at impact-row y).
  //   - Popup = group with 3+ tiles, ≥50% in digit-tile range $56-$5F.

  // 1. Build a per-frame inventory.
  const inventory = frames.map(f => {
    const sp3 = paletteKey(f.palettes.sp[3]);
    const groups = f.groups.map(g => ({
      origin: g.origin,
      tileCount: g.tiles.length,
      tileIds: [...new Set(g.tiles.map(t => t.id))].sort((a,b)=>a-b),
      side: isPartySide(g) ? 'party' : isEnemySide(g) ? 'enemy' : 'mid',
      isPopup: isDigitGroup(g),
      isMonsterRow: isMonsterRowOrigin(g.origin),
      raw: g,
    }));
    return { frameIdx: f.frameIdx, sp3, groups };
  });

  // 2. Cast end = last frame where every non-popup group is on party side.
  let castEnd = -1;
  for (let i = 0; i < inventory.length; i++) {
    const nonPopupNonParty = inventory[i].groups.filter(g => !g.isPopup && g.side !== 'party');
    if (nonPopupNonParty.length > 0) { castEnd = i - 1; break; }
  }
  if (castEnd === -1) castEnd = inventory.length - 1;

  // 3. Caster body / cast halo: pick the dominant party-side group during cast.
  const castFrame0PartyGroups = inventory[0]?.groups.filter(g => g.side === 'party') ?? [];
  const casterDominant = castFrame0PartyGroups.reduce((a, b) => (!a || b.tileCount > a.tileCount) ? b : a, null);

  const castSp3Timeline = [];
  for (let i = 0; i <= castEnd; i++) {
    const sp3 = inventory[i].sp3;
    if (castSp3Timeline.length === 0 || castSp3Timeline.at(-1).sp3 !== sp3) {
      castSp3Timeline.push({ frameIdx: inventory[i].frameIdx, sp3 });
    }
  }

  // 4. Projectile: post-cast (or late-cast) run of frames containing a small
  // (≤4 tile) non-popup group whose origin is sliding monotonically. We trace
  // it by looking at consecutive-frame origin deltas.
  const projectileTrace = [];
  for (let i = 1; i < inventory.length; i++) {
    const prev = inventory[i - 1], cur = inventory[i];
    for (const cg of cur.groups) {
      if (cg.isPopup) continue;
      if (cg.tileCount > 4) continue;
      // Match against any prev-frame group (any side) within a reasonable
      // movement budget, but with at least 1 unit of motion.
      const candidate = prev.groups.find(pg =>
        !pg.isPopup &&
        pg.tileCount <= 4 &&
        (Math.abs(pg.origin[0] - cg.origin[0]) + Math.abs(pg.origin[1] - cg.origin[1])) > 0 &&
        Math.abs(pg.origin[0] - cg.origin[0]) <= 32 &&
        Math.abs(pg.origin[1] - cg.origin[1]) <= 32
      );
      if (candidate) {
        projectileTrace.push({ frameIdx: cur.frameIdx, fromOrigin: candidate.origin, toOrigin: cg.origin, tileIds: cg.tileIds });
      }
    }
  }

  // 5. Walk enemy-side non-popup groups in frame order. Split into runs by
  // origin similarity. Tag the FIRST run after castEnd as impact; subsequent
  // runs are scorch (if at impact-row y) or death-wipe (if at monster-row y).
  const enemyRuns = [];
  let curRun = null;
  for (let i = 0; i < inventory.length; i++) {
    const enemyGs = inventory[i].groups.filter(g => g.side === 'enemy' && !g.isPopup);
    const dominant = enemyGs.reduce((a, b) => (!a || b.tileCount > a.tileCount) ? b : a, null);
    if (!dominant) {
      if (curRun) { enemyRuns.push(curRun); curRun = null; }
      continue;
    }
    if (!curRun) {
      curRun = newRun(inventory[i].frameIdx, dominant, inventory[i].sp3);
    } else {
      const sameOriginCluster =
        Math.abs(curRun.lastOrigin[0] - dominant.origin[0]) <= 16 &&
        Math.abs(curRun.lastOrigin[1] - dominant.origin[1]) <= 16;
      if (!sameOriginCluster) {
        enemyRuns.push(curRun);
        curRun = newRun(inventory[i].frameIdx, dominant, inventory[i].sp3);
      } else {
        curRun.endIdx = inventory[i].frameIdx;
        curRun.lastOrigin = dominant.origin;
        curRun.originSamples.push(dominant.origin);
        curRun.tileCount = Math.max(curRun.tileCount, dominant.tileCount);
        for (const id of dominant.tileIds) if (!curRun.tileIds.includes(id)) curRun.tileIds.push(id);
      }
    }
  }
  if (curRun) enemyRuns.push(curRun);

  // 6. Mid-side groups (between party and enemy) that aren't part of the
  // projectile trace — surface them as 'midScreen' so the user can label.
  const midScreenRuns = [];
  let mRun = null;
  for (let i = 0; i < inventory.length; i++) {
    const midGs = inventory[i].groups.filter(g => g.side === 'mid' && !g.isPopup);
    const dominant = midGs.reduce((a, b) => (!a || b.tileCount > a.tileCount) ? b : a, null);
    if (!dominant) {
      if (mRun) { midScreenRuns.push(mRun); mRun = null; }
      continue;
    }
    if (!mRun) {
      mRun = newRun(inventory[i].frameIdx, dominant, inventory[i].sp3);
    } else {
      mRun.endIdx = inventory[i].frameIdx;
      mRun.originSamples.push(dominant.origin);
      mRun.lastOrigin = dominant.origin;
    }
  }
  if (mRun) midScreenRuns.push(mRun);

  // 7. Popup runs (proper digit groups).
  const popupRuns = [];
  let pRun = null;
  for (let i = 0; i < inventory.length; i++) {
    const popups = inventory[i].groups.filter(g => g.isPopup);
    const dom = popups[0];
    if (!dom) {
      if (pRun) { popupRuns.push(pRun); pRun = null; }
      continue;
    }
    if (!pRun) pRun = newRun(inventory[i].frameIdx, dom, inventory[i].sp3);
    else {
      pRun.endIdx = inventory[i].frameIdx;
      pRun.originSamples.push(dom.origin);
      pRun.lastOrigin = dom.origin;
    }
  }
  if (pRun) popupRuns.push(pRun);

  // 8. Tag enemy runs. Impact must be a STATIC, MULTI-TILE burst (the
  // projectile-trace single-tile group that briefly enters enemy x must NOT
  // be picked as impact). Death-wipe = enemy-side run at monster-row y.
  enemyRuns.sort((a, b) => a.startIdx - b.startIdx);
  function isStaticBurst(r) {
    if (r.tileCount < 3) return false;
    const xs = r.originSamples.map(o => o[0]);
    const ys = r.originSamples.map(o => o[1]);
    return (Math.max(...xs) - Math.min(...xs) <= 8) && (Math.max(...ys) - Math.min(...ys) <= 8);
  }
  const impact = enemyRuns.find(r => isStaticBurst(r) && !isMonsterRowOrigin(r.originSamples[0])) || null;
  const deathWipe = enemyRuns.find(r => isMonsterRowOrigin(r.originSamples[0])) || null;
  // Scorch must be a real multi-tile static visual at impact-row y. The
  // single-tile projectile briefly entering enemy x must NOT show up as scorch.
  const scorch = enemyRuns.filter(r =>
    r !== impact && r !== deathWipe && r.tileCount >= 2 && !isMonsterRowOrigin(r.originSamples[0])
  );

  // Cap projectile range: it ends at impact start (or last frame if no impact).
  let projectileTraceCapped = projectileTrace;
  if (impact) {
    projectileTraceCapped = projectileTrace.filter(t => t.frameIdx < impact.startIdx);
  }

  return {
    totalFrames: frames.length,
    cast: {
      frames: [inventory[0]?.frameIdx ?? 0, inventory[castEnd]?.frameIdx ?? 0],
      casterOrigin: casterDominant?.origin ?? null,
      casterTileCount: casterDominant?.tileCount ?? 0,
      sp3Timeline: castSp3Timeline,
    },
    projectile: {
      detectedInOam: projectileTraceCapped.length > 0,
      frameRange: projectileTraceCapped.length > 0
        ? [projectileTraceCapped[0].frameIdx, projectileTraceCapped.at(-1).frameIdx]
        : null,
      sampleTrace: projectileTraceCapped.slice(0, 6),
      note: projectileTraceCapped.length === 0
        ? 'No moving OAM group detected before impact — projectile is likely BG-tile.'
        : `${projectileTraceCapped.length} consecutive moving-group frames before impact`,
    },
    impact: impact ? runToOut(impact) : null,
    scorch: scorch.map(runToOut),
    deathWipe: deathWipe ? runToOut(deathWipe) : null,
    midScreen: midScreenRuns.map(runToOut),
    popup: popupRuns.map(r => ({ frames: [r.startIdx, r.endIdx], originSamples: r.originSamples.slice(0, 5), tileIds: r.tileIds })),
  };
}

function newRun(frameIdx, dominant, sp3) {
  return {
    startIdx: frameIdx,
    endIdx: frameIdx,
    originSamples: [dominant.origin],
    lastOrigin: dominant.origin,
    tileCount: dominant.tileCount,
    tileIds: [...dominant.tileIds],
    sp3,
  };
}

function runToOut(r) {
  return {
    frames: [r.startIdx, r.endIdx],
    origin: r.originSamples[0],
    tileCount: r.tileCount,
    tileIds: r.tileIds,
    sp3: r.sp3,
    originSamples: r.originSamples.slice(0, 5),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('usage: node tools/classify-spell-phases.js <dump.txt> [--out out.json]');
    process.exit(1);
  }
  const dumpPath = args[0];
  const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

  const text = fs.readFileSync(dumpPath, 'utf8');
  const frames = parseDump(text);
  const phases = classifyPhases(frames);

  const json = JSON.stringify(phases, (_k, v) => {
    if (v && v.constructor === Uint8Array) return Array.from(v);
    return v;
  }, 2);

  if (outArg) {
    fs.writeFileSync(outArg, json);
    console.log(`wrote ${outArg}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
