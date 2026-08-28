#!/bin/zsh
set -euo pipefail

plugin_root="${0:A:h:h}"
build_root="${TMPDIR:-/tmp}/spotify-marquee-audio-build"
arm_binary="$build_root/audio-analyzer-arm64"
intel_binary="$build_root/audio-analyzer-x86_64"
output_binary="$plugin_root/bin/audio-analyzer"
expected_apple_team="CNFJQQGQD4"

if [[ -n "${PRISMBEAT_CODESIGN_IDENTITY:-}" && "$PRISMBEAT_CODESIGN_IDENTITY" != "Developer ID Application:"*"($expected_apple_team)" ]]; then
  print -u2 "Refusing to sign PrismBeat with an Apple identity outside the Punk Labs team ($expected_apple_team)."
  exit 1
fi

mkdir -p "$build_root"

xcrun swiftc \
  -swift-version 5 \
  -parse-as-library \
  -O \
  -target arm64-apple-macos13.0 \
  -framework CoreMedia \
  -framework CoreGraphics \
  -framework ScreenCaptureKit \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$plugin_root/native/Info.plist" \
  "$plugin_root/native/AudioAnalyzer.swift" \
  -o "$arm_binary"

xcrun swiftc \
  -swift-version 5 \
  -parse-as-library \
  -O \
  -target x86_64-apple-macos13.0 \
  -framework CoreMedia \
  -framework CoreGraphics \
  -framework ScreenCaptureKit \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$plugin_root/native/Info.plist" \
  "$plugin_root/native/AudioAnalyzer.swift" \
  -o "$intel_binary"

xcrun lipo -create "$arm_binary" "$intel_binary" -output "$output_binary"
chmod 755 "$output_binary"
if [[ -n "${PRISMBEAT_CODESIGN_IDENTITY:-}" ]]; then
  codesign \
    --force \
    --options runtime \
    --timestamp \
    --sign "$PRISMBEAT_CODESIGN_IDENTITY" \
    --identifier com.punklabs.prismbeat.audio-analyzer \
    "$output_binary"

  signature_details="$(codesign -dv --verbose=4 "$output_binary" 2>&1)"
  if [[ "$signature_details" != *"Authority=Developer ID Application:"* || "$signature_details" != *"TeamIdentifier=$expected_apple_team"* ]]; then
    print -u2 "The PrismBeat signature did not resolve to a Developer ID Application certificate for team $expected_apple_team."
    exit 1
  fi
else
  codesign \
    --force \
    --sign - \
    --identifier com.punklabs.prismbeat.audio-analyzer \
    "$output_binary"
fi

codesign --verify --strict --verbose=2 "$output_binary"
