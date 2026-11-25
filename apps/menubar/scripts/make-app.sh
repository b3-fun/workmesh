#!/usr/bin/env bash
# Builds a release binary and wraps it into Workmesh.app — a menu-bar agent
# (LSUIElement, no dock icon). No Xcode project needed; pure SwiftPM + bundling.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Workmesh"
# BUNDLE_ID overrides the id, e.g. a dev build that keeps its own defaults.
BUNDLE_ID="${BUNDLE_ID:-org.npclabs.workmesh.menubar}"
VERSION="${1:-0.1.0}"
OUT="${OUT:-dist}"

echo "Building release binary…"
swift build -c release

BIN="$(swift build -c release --show-bin-path)/WorkmeshMenuBar"
APP="$OUT/$APP_NAME.app"
CONTENTS="$APP/Contents"

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN" "$CONTENTS/MacOS/$APP_NAME"
chmod +x "$CONTENTS/MacOS/$APP_NAME"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>Workmesh</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <!-- Menu-bar agent: no dock icon, no main window. -->
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Seal the bundle with an ad hoc signature (no Apple Developer ID, no account).
# The linker signs only the binary, which leaves Info.plist unbound: a
# quarantined copy of that (a browser download) is "damaged and can't be opened",
# with no Open Anyway. Sealed, it verifies, and Gatekeeper rejects it only as an
# app that isn't notarized, which is what Open Anyway in Privacy & Security allows.
/usr/bin/codesign --force --sign - --timestamp=none "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"

echo "Built $APP (ad hoc signature, sealed)"

# ZIP=1: the release asset the menu bar app updates itself from. Made from this
# local build with ditto, which has no quarantine flag to store (ditto keeps the
# flags of the items inside an app, so never zip a downloaded copy).
if [ "${ZIP:-}" = "1" ]; then
  ZIPFILE="$OUT/Workmesh-menubar-macos.zip"
  rm -f "$ZIPFILE"
  (cd "$OUT" && /usr/bin/ditto -c -k --keepParent "$APP_NAME.app" "Workmesh-menubar-macos.zip")
  echo "Zipped $ZIPFILE"
  echo "  sha256 $(shasum -a 256 "$ZIPFILE" | cut -d' ' -f1)"
fi
echo "Run it:  open \"$APP\"    (or double-click)"
echo
echo "Not signed with a Developer ID. Built here, it carries no quarantine flag and opens as is."
echo "A copy downloaded in a browser needs Open Anyway once: docs/guide/getting-started.md."
