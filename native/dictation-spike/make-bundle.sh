#!/usr/bin/env bash
# Wrap the CLI in a minimal signed .app bundle.
#
# Custom language models may be keyed to a bundle identifier, which a bare
# executable does not have. This also mirrors how the binary would actually ship.
set -eu

cd "$(dirname "$0")"
swift build >/dev/null

app=/tmp/T3Dictate.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp .build/debug/t3-dictate "$app/Contents/MacOS/t3-dictate"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.incognitojam.t3code.dictate</string>
  <key>CFBundleName</key>
  <string>T3Dictate</string>
  <key>CFBundleExecutable</key>
  <string>t3-dictate</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>26.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Dictation spike records audio to test on-device transcription.</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$app" >/dev/null 2>&1

echo "$app/Contents/MacOS/t3-dictate"
