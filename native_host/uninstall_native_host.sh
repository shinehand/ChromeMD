#!/bin/zsh
set -euo pipefail

HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_DIR/com.chromemd.native_host.json"

if [ -f "$HOST_MANIFEST" ]; then
  rm -f "$HOST_MANIFEST"
  echo "Removed $HOST_MANIFEST"
else
  echo "Native host manifest not found: $HOST_MANIFEST"
fi
