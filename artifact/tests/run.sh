#!/usr/bin/env bash
# Runs the lost-highlight repro against artifact/index.html in headless Chromium.
#
# Uses a Chromium-based browser already on the machine and node's own http
# module, so there is nothing to install. Exits non-zero while the bug is present.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8731}"

# Any Chromium will do: the assertions measure Blink's behaviour, not Chrome's.
# First match wins; CHROME overrides the search.
if [ -z "${CHROME:-}" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Brave.app/Contents/MacOS/Brave Browser" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*; do
    [ -x "$candidate" ] && { CHROME="$candidate"; break; }
  done
fi

[ -x "${CHROME:-}" ] || { echo "no Chromium-based browser found (set CHROME=...)"; exit 2; }

# .cjs so the root package.json's "type": "module" cannot change how it loads.
SERVER_LOG="$(mktemp)"
node "$ROOT/tests/serve.cjs" "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; rm -f "$SERVER_LOG"' EXIT

UP=
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/index.html" >/dev/null && { UP=1; break; }
  sleep 0.1
done
# Say so here, or a dead server surfaces later as "the driver did not run".
[ -n "$UP" ] || { echo "the test server did not start:"; cat "$SERVER_LOG"; exit 2; }

DOM="$("$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=20000 --dump-dom \
  "http://127.0.0.1:$PORT/index.html" 2>/dev/null)"

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
