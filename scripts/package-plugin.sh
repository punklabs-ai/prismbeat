#!/bin/zsh
set -euo pipefail

repository_root="${0:A:h:h}"
plugin_root="$repository_root/com.punklabs.prismbeat.sdPlugin"
output_root="$repository_root/dist"
cli_version="1.9.0"
expected_apple_team="CNFJQQGQD4"
reuse_notarized_helper="${PRISMBEAT_REUSE_NOTARIZED_HELPER:-0}"
package_staging_parent=""
package_test_root=""

cleanup() {
  if [[ -n "$package_staging_parent" ]]; then
    rm -rf -- "${package_staging_parent:?}"
  fi
  if [[ -n "$package_test_root" ]]; then
    rm -rf -- "${package_test_root:?}"
  fi
}

trap cleanup EXIT INT TERM

if [[ "$reuse_notarized_helper" != "1" ]]; then
  if [[ -z "${PRISMBEAT_CODESIGN_IDENTITY:-}" ]]; then
    print -u2 "PRISMBEAT_CODESIGN_IDENTITY is required for a production package."
    exit 1
  fi

  if [[ "$PRISMBEAT_CODESIGN_IDENTITY" != "Developer ID Application:"*"($expected_apple_team)" ]]; then
    print -u2 "Refusing to package PrismBeat with an Apple identity outside the Punk Labs team ($expected_apple_team)."
    print -u2 "Use a Developer ID Application certificate for team $expected_apple_team."
    exit 1
  fi

  if [[ -z "${PRISMBEAT_NOTARY_PROFILE:-}" ]]; then
    print -u2 "PRISMBEAT_NOTARY_PROFILE is required."
    exit 1
  fi
fi

for helper in \
  "$plugin_root/bin/windows-x64/prismbeat-windows.exe" \
  "$plugin_root/bin/windows-arm64/prismbeat-windows.exe"; do
  if [[ ! -x "$helper" ]]; then
    print -u2 "Missing Windows release helper: $helper"
    exit 1
  fi
done

mkdir -p "$output_root"

cd "$plugin_root"
npm ci
if [[ "$reuse_notarized_helper" == "1" ]]; then
  signature_details=$(codesign -dv --verbose=4 "$plugin_root/bin/audio-analyzer" 2>&1)
  if [[ "$signature_details" != *"Authority=Developer ID Application: PUNK LABS LTD ($expected_apple_team)"* \
    || "$signature_details" != *"TeamIdentifier=$expected_apple_team"* \
    || "$signature_details" != *"flags=0x10000(runtime)"* ]]; then
    print -u2 "The existing macOS helper is not a hardened PUNK LABS Developer ID build."
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$plugin_root/bin/audio-analyzer"
  codesign \
    --verify \
    --verbose=4 \
    -R='notarized' \
    --check-notarization \
    "$plugin_root/bin/audio-analyzer"
else
  npm run build:audio
  "$repository_root/scripts/notarize-macos-helper.sh" "$plugin_root/bin/audio-analyzer"
fi
npm test

cd "$repository_root"
package_staging_parent=$(mktemp -d "${TMPDIR:-/tmp}/prismbeat-package.XXXXXX")
package_staging_root="$package_staging_parent/com.punklabs.prismbeat.sdPlugin"
/usr/bin/ditto "$plugin_root" "$package_staging_root"
/bin/cp "$repository_root/LICENSE" "$package_staging_root/LICENSE.txt"
/bin/cp "$repository_root/NOTICE" "$package_staging_root/NOTICE.txt"
/bin/cp "$repository_root/ASSETS.md" "$package_staging_root/ASSETS.md"

npx --yes "@elgato/cli@$cli_version" validate "$package_staging_root" --force-update-check
npx --yes "@elgato/cli@$cli_version" pack "$package_staging_root" --output "$output_root" --force --no-file-list

package_test_root=$(mktemp -d "${TMPDIR:-/tmp}/prismbeat-package-test.XXXXXX")
/usr/bin/ditto \
  -x \
  -k \
  "$output_root/com.punklabs.prismbeat.streamDeckPlugin" \
  "$package_test_root"
extracted_plugin="$package_test_root/com.punklabs.prismbeat.sdPlugin"
PRISMBEAT_PERMISSION_TEST_PLUGIN_ROOT="$extracted_plugin" \
PRISMBEAT_PERMISSION_TEST_ANALYZER_PATH="$extracted_plugin/bin/audio-analyzer" \
  node "$plugin_root/tests/macos-helper-permission.mjs"

print "Created $output_root/com.punklabs.prismbeat.streamDeckPlugin"
