#!/usr/bin/env node
// Print recent roster trades (audit log) from the prod SQLite DB.
//   node tools/trade-audit.cjs [limit]
//   node tools/trade-audit.cjs sender <userId> [limit]
//   node tools/trade-audit.cjs item <itemIdHex|dec> [limit]
// Run from the repo root (where ff3mmo.db lives). CommonJS (.cjs) because
// better-sqlite3 is a native require and the package is type:module.
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'ff3mmo.db'), { readonly: true });

const argv = process.argv.slice(2);
const mode = (argv[0] === 'sender' || argv[0] === 'item') ? argv[0] : null;
const filterArg = mode ? argv[1] : null;
const limit = Math.min(parseInt(argv[mode ? 2 : 0], 10) || 50, 500);

let rows;
if (mode === 'sender') {
  rows = db.prepare(
    `SELECT id, ts, sender_user_id, sender_name, target_user_id, target_name, item_id, accepted, reason
     FROM trades WHERE sender_user_id = ? ORDER BY id DESC LIMIT ?`
  ).all(parseInt(filterArg, 10) | 0, limit);
} else if (mode === 'item') {
  const itemId = filterArg.startsWith('0x') ? parseInt(filterArg, 16) : parseInt(filterArg, 10);
  rows = db.prepare(
    `SELECT id, ts, sender_user_id, sender_name, target_user_id, target_name, item_id, accepted, reason
     FROM trades WHERE item_id = ? ORDER BY id DESC LIMIT ?`
  ).all(itemId | 0, limit);
} else {
  rows = db.prepare(
    `SELECT id, ts, sender_user_id, sender_name, target_user_id, target_name, item_id, accepted, reason
     FROM trades ORDER BY id DESC LIMIT ?`
  ).all(limit);
}

if (!rows.length) { console.log('No trades.'); process.exit(0); }

console.log('#id  ts                    sender                target                item    accept  reason');
for (const r of rows) {
  const when = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19);
  const sender = `${r.sender_user_id}/${r.sender_name || '?'}`.padEnd(20).slice(0, 20);
  const target = `${r.target_user_id}/${r.target_name || '?'}`.padEnd(20).slice(0, 20);
  const item   = ('0x' + r.item_id.toString(16).padStart(2, '0')).padEnd(6);
  const ok     = (r.accepted ? 'YES' : 'no ').padEnd(7);
  console.log(`#${String(r.id).padStart(4)}  ${when}  ${sender}  ${target}  ${item}  ${ok}  ${r.reason || ''}`);
}
