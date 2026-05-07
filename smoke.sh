#!/bin/bash
# Headless smoke test — load ff3mmo.com (or $1) and grep for runtime errors
# that `node --check` misses (orphaned imports, undefined globals at module
# evaluation time, etc.). Exits 0 on clean, 1 on any matched error.
#
# Usage:
#   ./smoke.sh                    # tests https://ff3mmo.com
#   ./smoke.sh --local            # boot npm start, smoke localhost:3000, tear down
#   ./smoke.sh http://localhost:3000   # smoke an already-running local server
#   ./smoke.sh ff3mmo.com         # bare host — https:// added

set -u

LOCAL_PID=""
cleanup_local() {
  if [[ -n "$LOCAL_PID" ]]; then kill "$LOCAL_PID" 2>/dev/null || true; fi
}

if [[ "${1:-}" == "--local" ]]; then
  echo "smoke: --local — starting npm start"
  npm start >/tmp/ff3mmo-smoke-server.log 2>&1 &
  LOCAL_PID=$!
  trap cleanup_local EXIT
  # Wait for server (max 10 s).
  for _ in $(seq 1 20); do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q 200; then break; fi
    sleep 0.5
  done
  URL="http://localhost:3000"
else
  URL="${1:-https://ff3mmo.com}"
  [[ "$URL" != http* ]] && URL="https://$URL"
fi

# Pick the first Chromium-like browser available.
BROWSER=""
for cmd in chromium chromium-browser google-chrome chrome; do
  if command -v "$cmd" >/dev/null 2>&1; then BROWSER="$cmd"; break; fi
done
if [[ -z "$BROWSER" ]]; then
  echo "smoke: no chromium/chrome found in PATH" >&2
  exit 2
fi

LOG=$(mktemp -t ff3mmo-smoke.XXXXXX.log)
trap 'cleanup_local; rm -f "$LOG"' EXIT

echo "smoke: $URL"

# 1. Page returns 200. Poll up to 20 s — pm2 restart takes ~3 s to rebind the
# port and the deploy script fires us right after the restart, so single-shot
# curl will see a transient 502/503 from nginx.
HTTP=000
for _ in $(seq 1 40); do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
  [[ "$HTTP" == "200" ]] && break
  sleep 0.5
done
if [[ "$HTTP" != "200" ]]; then
  echo "smoke: FAIL — $URL still returning HTTP $HTTP after 20 s"
  exit 1
fi

# 2. Headless load with virtual-time so JS actually executes (not just initial
# DOM parse). 20 s of virtual time is enough for boot + module init; the page
# gates behind the dev-password / ROM-upload screen anyway, so we're testing
# module-evaluation, not gameplay.
timeout 30 "$BROWSER" --headless=new --disable-gpu \
  --enable-logging=stderr --v=1 \
  --virtual-time-budget=20000 \
  --dump-dom "$URL" 2>"$LOG" >/dev/null
RC=$?
if [[ $RC -ne 0 ]] && [[ $RC -ne 124 ]]; then
  # 124 = timeout's expected exit; anything else is a real browser failure.
  echo "smoke: FAIL — $BROWSER exited $RC"
  echo "--- stderr tail ---"
  tail -40 "$LOG"
  exit 1
fi

# 3. Grep for runtime errors. Filter Blink's verbose chatter and unrelated
# 404 histograms; anything left is a real defect.
HITS=$(grep -iE "ReferenceError|TypeError|SyntaxError|Uncaught|cannot find module|net::ERR_" "$LOG" \
  | grep -v "modulator_impl\|VERBOSE1.*chromewebdata\|GoogleChromeLabs\|fonts\.gstatic\|rejected promise" \
  | grep -v "Histogram:.*404")

if [[ -n "$HITS" ]]; then
  echo "smoke: FAIL — runtime errors detected"
  echo "--- error lines ---"
  echo "$HITS"
  echo "--- (full log: $LOG — retained) ---"
  trap 'cleanup_local' EXIT  # keep $LOG around; still tear down --local server
  exit 1
fi

echo "smoke: OK"
exit 0
