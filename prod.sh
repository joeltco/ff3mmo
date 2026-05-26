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
