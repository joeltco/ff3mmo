#!/bin/bash
# tools/coop-debug-grep.sh — fetch the most recent [coop-viewer] event timeline
# from prod pm2 logs. Use after a failed two-phone smoke to see exactly where
# the viewer broke (or didn't fire at all).
#
# Usage:
#   ./tools/coop-debug-grep.sh              # last 50 viewer events
#   ./tools/coop-debug-grep.sh 200          # last 200 viewer events
#   ./tools/coop-debug-grep.sh 500 anim     # last 500 lines, filter by substring
#
# Spec: docs/COOP-VIEWER-PLAN.md (instrumentation in P9.2).

set -e

LINES="${1:-50}"
FILTER="${2:-coop-viewer}"

PROD_HOST="root@68.183.59.19"
LOG_FILE="/root/.pm2/logs/server-error.log"

echo "=== [coop-viewer] event timeline (last $LINES matching, filter: $FILTER) ==="
echo

ssh -o ConnectTimeout=10 "$PROD_HOST" "tail -3000 $LOG_FILE | grep -E '$FILTER' | tail -$LINES"

echo
echo "=== done ==="
echo
echo "Common follow-ups:"
echo "  ./tools/coop-debug-grep.sh 200 'enterViewerMode\\|invite-received'   # spawn path"
echo "  ./tools/coop-debug-grep.sh 200 'ingest\\|anim-begin\\|anim-done'      # event flow"
echo "  ./tools/coop-debug-grep.sh 200 'BATTLE DRAW ERROR\\|TypeError'        # crashes"
