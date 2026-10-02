#!/usr/bin/env bash
set -euo pipefail

APP_NAME="PR Review"
DEST="/Applications/$APP_NAME.app"
REPO="matteomekhail/pr-review"

if [ "${1:-}" != "--from-source" ] && command -v gh >/dev/null; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if gh release download -R "$REPO" --pattern '*.app.tar.gz' --dir "$TMP" --clobber 2>/dev/null; then
    tar -xzf "$TMP"/*.app.tar.gz -C "$TMP"
    osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
    rm -rf "$DEST"
    ditto "$TMP/$APP_NAME.app" "$DEST"
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
    open "$DEST"
    echo "Installed the latest release to $DEST (it auto-updates from now on)"
    exit 0
  fi
  echo "No release found yet; building from source."
fi

for tool in bun cargo gh git; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install it first (see README → Requirements)." >&2; exit 1; }
done

if [ -f package.json ] && grep -q '"name": "pr-review"' package.json; then
  SRC="$(pwd)"
else
  SRC="${PR_REVIEW_DIR:-$HOME/.pr-review}"
  if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only -q; else gh repo clone matteomekhail/pr-review "$SRC" -- -q; fi
fi

cd "$SRC"
bun install --frozen-lockfile
bun run app

osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
ditto "src-tauri/target/release/bundle/macos/$APP_NAME.app" "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" || true
open "$DEST"
echo "Installed $DEST"
