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
