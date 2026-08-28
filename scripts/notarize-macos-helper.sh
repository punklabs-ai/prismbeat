#!/bin/zsh
set -euo pipefail

helper_path="${1:-}"

if [[ -z "$helper_path" || ! -x "$helper_path" ]]; then
  print -u2 "Usage: PRISMBEAT_NOTARY_PROFILE=<profile> $0 <audio-analyzer>"
  exit 1
fi

if [[ -z "${PRISMBEAT_NOTARY_PROFILE:-}" ]]; then
  print -u2 "PRISMBEAT_NOTARY_PROFILE is required."
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$helper_path"

notary_root=$(mktemp -d "${TMPDIR:-/tmp}/prismbeat-notary.XXXXXX")
notary_archive="$notary_root/audio-analyzer.zip"
trap 'rm -rf -- "$notary_root"' EXIT INT TERM

/usr/bin/ditto -c -k --keepParent "$helper_path" "$notary_archive"
xcrun notarytool submit \
  "$notary_archive" \
  --keychain-profile "$PRISMBEAT_NOTARY_PROFILE" \
  --wait

# Standalone executables receive an online notarization ticket, but Apple does
# not support stapling that ticket to the raw binary. `spctl` also classifies a
# raw helper as "not an app", so verify the published ticket as a code-signing
# requirement instead.
codesign \
  --verify \
  --verbose=4 \
  -R='notarized' \
  --check-notarization \
  "$helper_path"
