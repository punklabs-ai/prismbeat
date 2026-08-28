#!/bin/sh
set -eu

PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT="$PLUGIN_ROOT/native/windows/PrismBeat.Windows.csproj"
DOTNET_COMMAND=${DOTNET_BIN:-dotnet}
TEMP_OUTPUT=$(mktemp -d "${TMPDIR:-/tmp}/prismbeat-windows.XXXXXX")
trap 'rm -rf "$TEMP_OUTPUT"' EXIT INT TERM

for RUNTIME in win-x64 win-arm64; do
  ARCH=${RUNTIME#win-}
  OUTPUT_DIRECTORY="$PLUGIN_ROOT/bin/windows-$ARCH"
  mkdir -p "$OUTPUT_DIRECTORY"
  "$DOTNET_COMMAND" publish "$PROJECT" \
    --configuration Release \
    --runtime "$RUNTIME" \
    --self-contained true \
    --output "$TEMP_OUTPUT/$RUNTIME"
  install -m 755 \
    "$TEMP_OUTPUT/$RUNTIME/prismbeat-windows.exe" \
    "$OUTPUT_DIRECTORY/prismbeat-windows.exe"
done

echo "Built PrismBeat Windows helpers for x64 and ARM64."
