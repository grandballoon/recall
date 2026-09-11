#!/usr/bin/env bash
#
# Build Recall and install it into /Applications as a real Mac app, so it can be
# launched (and kept) in the Dock like anything else.
#
# Re-run it whenever you want the installed app to catch up with the source —
# it replaces the installed copy in place, so the Dock tile keeps working.
#
# Usage: scripts/install-macos.sh [--no-dock]

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUNDLE_ID="com.grandballoon.recall"
APP_NAME="Recall.app"
DEST="/Applications/$APP_NAME"
ADD_TO_DOCK=1

for arg in "$@"; do
  case "$arg" in
    --no-dock) ADD_TO_DOCK=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- signing ---------------------------------------------------------------
# A Developer ID signature gives the app a stable identity across rebuilds, so
# the Keychain keeps trusting it with the stored Anthropic key instead of
# re-asking after every install. Without one we fall back to an ad-hoc
# signature, which works but changes on every build.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  found=$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Developer ID Application/ { print $2; exit }')
  if [[ -n "$found" ]]; then
    export APPLE_SIGNING_IDENTITY="$found"
    echo "==> signing as: $found"
  else
    export APPLE_SIGNING_IDENTITY="-"
    echo "==> no Developer ID found; signing ad-hoc (macOS will re-ask for Keychain access after each install)"
  fi
fi

# --- build -----------------------------------------------------------------
echo "==> building"
cd "$REPO_ROOT/src-tauri"
cargo tauri build --bundles app

BUILT="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
[[ -d "$BUILT" ]] || { echo "build produced no $APP_NAME" >&2; exit 1; }

# --- install ---------------------------------------------------------------
# Only ever replace a bundle that is actually Recall, so a name collision in
# /Applications can never cost someone another app.
if [[ -e "$DEST" ]]; then
  existing=$(defaults read "$DEST/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo "")
  if [[ "$existing" != "$BUNDLE_ID" ]]; then
    echo "$DEST exists and is not Recall (identifier: ${existing:-unknown}) — leaving it alone" >&2
    exit 1
  fi
  echo "==> replacing existing install"
  # Quit a running copy first; a running bundle cannot be replaced cleanly.
  osascript -e "tell application \"$DEST\" to quit" >/dev/null 2>&1 || true
  rm -rf "$DEST"
fi

echo "==> installing to $DEST"
ditto "$BUILT" "$DEST"

# Tell LaunchServices about the new copy so the Dock and Spotlight pick up the
# current icon and version rather than a cached one.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$DEST" >/dev/null 2>&1 || true

# --- dock ------------------------------------------------------------------
if [[ "$ADD_TO_DOCK" == "1" ]]; then
  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "$APP_NAME"; then
    echo "==> already in the Dock"
  else
    echo "==> adding to the Dock"
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$DEST</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
    killall Dock
  fi
fi

echo "==> done — Recall is installed at $DEST"
