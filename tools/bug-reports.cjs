#!/usr/bin/env node
// Print recent player bug reports from the prod SQLite DB.
//   node tools/bug-reports.cjs [limit]
// Run from the repo root (where ff3mmo.db lives). CommonJS (.cjs) because
// better-sqlite3 is a native require and the package is type:module.
const path = require('path');
const Database = require('better-sqlite3');

const limit = Math.min(parseInt(process.argv[2], 10) || 50, 500);
const db = new Database(path.join(__dirname, '..', 'ff3mmo.db'), { readonly: true });

const rows = db.prepare(
  `SELECT id, created_at, player_name, version, map_id, tile_x, tile_y,
          on_world_map, dungeon_floor, battle_state, text
   FROM bug_reports ORDER BY id DESC LIMIT ?`
).all(limit);

if (!rows.length) { console.log('No bug reports.'); process.exit(0); }

for (const r of rows) {
  const when = new Date(r.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const where = r.on_world_map
    ? `world (${r.tile_x},${r.tile_y})`
    : `map ${r.map_id}${r.dungeon_floor >= 0 ? ` f${r.dungeon_floor}` : ''} (${r.tile_x},${r.tile_y})`;
  const battle = r.battle_state && r.battle_state !== 'none' ? ` | battle:${r.battle_state}` : '';
  console.log(`#${r.id}  ${when}  ${r.player_name || '?'}  [${r.version || '?'}]  ${where}${battle}`);
  console.log(`    ${r.text}\n`);
}
