#!/usr/bin/env bash
# Runs the lost-highlight repro against src/index.html in headless Chrome.
#
# Uses the Chrome already on the machine and node's own http module, so there is
# nothing to install. Exits non-zero while the bug is present.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8731}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME (set CHROME=...)"; exit 2; }

node "$ROOT/tests/serve.js" "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null' EXIT

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/src/claude.js" >/dev/null && break
  sleep 0.1
done

DOM="$("$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=20000 --dump-dom \
  "http://127.0.0.1:$PORT/src/index.html" 2>/dev/null)"

# The results sit in one <pre>; isolate it before reading lines, since the
# first and last ones share a line with the surrounding markup.
RESULTS="$(printf '%s' "$DOM" \
  | tr '\n' '\001' \
  | sed 's/.*<pre id="recall-test-results">//; s|</pre>.*||' \
  | tr '\001' '\n' | grep '^RECALL-TEST' || true)"
if [ -z "$RESULTS" ]; then
  echo "no results — the driver did not run"
  exit 2
fi

printf '%s\n' "$RESULTS"
printf '%s' "$RESULTS" | grep -q '^RECALL-TEST FAIL' && exit 1
exit 0
