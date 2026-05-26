#!/bin/bash
# prod.sh — quick prod-state inspector. Single command answers "what's
# happening on ff3mmo.com right now?" without remembering the SSH
# incantation, the SQLite query, or the pm2 grep.
#
# Usage:
#   ./prod.sh                 # default: status (health + who's on + recent errors)
#   ./prod.sh status          # explicit version of the default
#   ./prod.sh who             # who's connected (recent presence shadows)
#   ./prod.sh diag            # tail STATUS-DIAG lines live (Ctrl-C to stop)
#   ./prod.sh errors          # last 20 CLIENT ERROR lines
#   ./prod.sh logs [N]        # last N pm2 lines (default 50)
#   ./prod.sh tail            # live pm2 tail (Ctrl-C to stop)
#   ./prod.sh dup [N]         # trade dup-spam detector (default threshold 5 same-item trades / sender / 7d)
#   ./prod.sh inv [userId]    # inventory mirror summary (no arg = totals; userId = per-slot detail)
#   ./prod.sh sql "<query>"   # arbitrary read-only SQLite query
#
# Host/path are pinned to match deploy.sh.

set -u

HOST="root@68.183.59.19"
APP_DIR="/var/www/ff3mmo"
HEALTH_URL="https://ff3mmo.com/health"

CMD="${1:-status}"

# Helper: run a one-shot node -e on prod with the SQLite db opened.
# Pass the JS body as $1 — Database is in scope as `db`, `now` is unix
# seconds, results auto-line-printed via console.log inside the body.
_sql() {
  local body="$1"
  ssh -o StrictHostKeyChecking=no "$HOST" "cd $APP_DIR && node -e \"
    const Database = require('better-sqlite3');
    const db = new Database('./ff3mmo.db', { readonly: true });
    const now = Math.floor(Date.now()/1000);
    ${body}
  \""
}

case "$CMD" in

  status)
    echo "── health ─────────────────────────────────"
    curl -s "$HEALTH_URL" | sed 's/,/\n  /g; s/{/  /; s/}//'
    echo
    echo
    echo "── recent presence (top 5) ────────────────"
    _sql "
      const rows = db.prepare('SELECT user_id, name, loc, last_seen FROM presence_shadows ORDER BY last_seen DESC LIMIT 5').all();
      for (const r of rows) {
        const age = now - r.last_seen;
        const ago = age < 60 ? age + 's' : age < 3600 ? Math.floor(age/60) + 'm' : Math.floor(age/3600) + 'h';
        console.log('  ' + String(r.user_id).padStart(3) + ' ' + r.name.padEnd(16) + ' loc=' + (r.loc || '?').padEnd(16) + ' ' + ago + ' ago');
      }
    "
    echo
    echo "── recent CLIENT ERROR (last 5) ───────────"
    ssh -o StrictHostKeyChecking=no "$HOST" "pm2 logs server --lines 500 --nostream --raw 2>&1 | grep -E 'CLIENT ERROR|STATUS-DIAG' | tail -5"
    ;;

  who)
    echo "── recent presence (last hour) ────────────"
    _sql "
      const rows = db.prepare('SELECT user_id, name, loc, last_seen FROM presence_shadows WHERE last_seen > ? ORDER BY last_seen DESC LIMIT 30').all(now - 3600);
      if (!rows.length) { console.log('  (no activity in the last hour)'); }
      for (const r of rows) {
        const age = now - r.last_seen;
        const ago = age < 60 ? age + 's' : age < 3600 ? Math.floor(age/60) + 'm' : Math.floor(age/3600) + 'h';
        console.log('  ' + String(r.user_id).padStart(3) + ' ' + r.name.padEnd(16) + ' loc=' + (r.loc || '?').padEnd(16) + ' ' + ago + ' ago');
      }
    "
    echo
    echo "── /health ────────────────────────────────"
    curl -s "$HEALTH_URL"
    echo
    ;;

  diag)
    echo "── tailing STATUS-DIAG (Ctrl-C to stop) ───"
    ssh -o StrictHostKeyChecking=no "$HOST" "pm2 logs server --raw 2>&1 | grep --line-buffered STATUS-DIAG"
    ;;

  errors)
    echo "── last 20 CLIENT ERROR lines ─────────────"
    ssh -o StrictHostKeyChecking=no "$HOST" "pm2 logs server --lines 1000 --nostream --raw 2>&1 | grep 'CLIENT ERROR' | tail -20"
    ;;

  logs)
    LINES="${2:-50}"
    ssh -o StrictHostKeyChecking=no "$HOST" "pm2 logs server --lines $LINES --nostream --raw 2>&1 | tail -$LINES"
    ;;

  tail)
    echo "── live pm2 tail (Ctrl-C to stop) ─────────"
    ssh -o StrictHostKeyChecking=no "$HOST" "pm2 logs server --raw"
    ;;

  dup)
    # Trade dup-spam detector. Flags any sender who has accepted N+ trades of
    # the same item id in the last 7 days. Threshold N defaults to 5 — bump
    # for noisier accounts, lower to investigate.
    #
    # Backstop for V-A (trade dup) from the dup-vector audit
    # (docs/INVENTORY-MIRROR-PLAN.md). Server doesn't validate sender owns the
    # item, so the `trades` audit log is the only real-time signal. Run this
    # periodically (or on alert) until the Phase 3 trade-on-server mirror
    # lands. v1.7.739.
    #
    # NOTE: `give-item` is NOT logged yet (V-B gap in the audit). This query
    # only sees trade traffic. Cf. INVENTORY-MIRROR-PLAN.md "Forensic" tier.
    THRESH="${2:-5}"
    echo "── trade dup-spam (sender → same item ≥${THRESH}× / 7d) ──"
    _sql "
      const since = Date.now() - 7 * 86400 * 1000;
      const sql = 'SELECT sender_user_id, sender_name, item_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT target_user_id) AS targets, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM trades WHERE accepted = 1 AND ts > ? GROUP BY sender_user_id, item_id HAVING n >= ? ORDER BY n DESC, last_ts DESC';
      const rows = db.prepare(sql).all(since, ${THRESH});
      if (!rows.length) { console.log('  (no flagged senders in the last 7d at threshold ' + ${THRESH} + ')'); }
      for (const r of rows) {
        const spanMin = Math.round((r.last_ts - r.first_ts) / 60000);
        const spanStr = spanMin < 60 ? spanMin + 'm' : Math.round(spanMin / 60) + 'h';
        const itemHex = '0x' + r.item_id.toString(16).toUpperCase().padStart(2, '0');
        console.log('  sender=' + r.sender_user_id + ' (' + (r.sender_name||'?') + ')  item=' + itemHex + '  trades=' + r.n + '  span=' + spanStr + '  targets=[' + r.targets + ']');
      }
    "
    ;;

  inv)
    # Inventory mirror visibility (Phase 0 of the inventory mirror —
    # docs/INVENTORY-MIRROR-PLAN.md). No arg = totals across all users /
    # slots. With a userId = per-slot detail for that user (inventory +
    # gil + equipment + spell count). Read-only against the inv_* tables.
    USER_ID="${2:-}"
    if [[ -z "$USER_ID" ]]; then
      echo "── mirror totals ──────────────────────────"
      _sql "
        const counts = {
          inv_inventories: db.prepare('SELECT COUNT(*) AS n FROM inv_inventories').get().n,
          inv_economies:   db.prepare('SELECT COUNT(*) AS n FROM inv_economies').get().n,
          inv_equipped:    db.prepare('SELECT COUNT(*) AS n FROM inv_equipped').get().n,
          inv_known_spells:db.prepare('SELECT COUNT(*) AS n FROM inv_known_spells').get().n,
          inv_job_levels:  db.prepare('SELECT COUNT(*) AS n FROM inv_job_levels').get().n,
        };
        for (const [t, n] of Object.entries(counts)) console.log('  ' + t.padEnd(20) + ' ' + n);
        const users = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM inv_economies').get().n;
        const slots = db.prepare('SELECT COUNT(*) AS n FROM inv_economies').get().n;
        console.log('  users with mirror   ' + users);
        console.log('  total (user, slot)  ' + slots);
      "
    else
      echo "── mirror detail for user $USER_ID ────────────"
      _sql "
        const uid = ${USER_ID};
        const econ = db.prepare('SELECT slot, gil, cp, exp, unlocked_jobs, updated_at FROM inv_economies WHERE user_id = ? ORDER BY slot').all(uid);
        if (!econ.length) { console.log('  (no mirror data for user ' + uid + ')'); }
        for (const e of econ) {
          const eq = db.prepare('SELECT weapon_r, weapon_l, head, body, arms FROM inv_equipped WHERE user_id = ? AND slot = ?').get(uid, e.slot) || {};
          const inv = db.prepare('SELECT item_id, qty FROM inv_inventories WHERE user_id = ? AND slot = ? ORDER BY item_id').all(uid, e.slot);
          const sp  = db.prepare('SELECT COUNT(*) AS n FROM inv_known_spells WHERE user_id = ? AND slot = ?').get(uid, e.slot).n;
          const jobs= db.prepare('SELECT COUNT(*) AS n FROM inv_job_levels WHERE user_id = ? AND slot = ?').get(uid, e.slot).n;
          const ago = Math.round((now - e.updated_at) / 60) + 'm ago';
          console.log('  slot ' + e.slot + '  gil=' + e.gil + '  cp=' + e.cp + '  exp=' + e.exp + '  jobs-unlocked=0x' + (e.unlocked_jobs>>>0).toString(16) + '  (' + ago + ')');
          const hex = b => '0x' + (b|0).toString(16).toUpperCase().padStart(2,'0');
          console.log('    equipped: R=' + hex(eq.weapon_r) + ' L=' + hex(eq.weapon_l) + ' head=' + hex(eq.head) + ' body=' + hex(eq.body) + ' arms=' + hex(eq.arms));
          console.log('    inventory (' + inv.length + ' slots): ' + inv.map(i => hex(i.item_id) + 'x' + i.qty).join('  '));
          console.log('    known_spells=' + sp + '  job_levels=' + jobs);
        }
      "
    fi
    ;;

  sql)
    QUERY="${2:-}"
    if [[ -z "$QUERY" ]]; then
      echo "usage: ./prod.sh sql \"SELECT ... FROM ...\""
      exit 1
    fi
    # Escape inner quotes for the node string; pass the JS body that runs the prepared query.
    QUERY_ESC="${QUERY//\"/\\\"}"
    _sql "
      const rows = db.prepare(\\\"${QUERY_ESC}\\\").all();
      console.log(JSON.stringify(rows, null, 2));
    "
    ;;

  -h|--help|help)
    sed -n '2,16p' "$0" | sed 's/^# //; s/^#$//'
    ;;

  *)
    echo "prod.sh: unknown command '$CMD'"
    echo "try: ./prod.sh help"
    exit 1
    ;;

esac
