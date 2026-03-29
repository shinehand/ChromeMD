#!/bin/zsh
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: ./native_host/install_native_host.sh <extension-id>"
  exit 1
fi

EXTENSION_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/chromemd_native_host.py"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_NAME="com.chromemd.native_host"
HOST_MANIFEST="$HOST_DIR/$HOST_NAME.json"

if [ -z "${PYTHON_BIN}" ]; then
  echo "python3 not found"
  exit 1
fi

if [ ! -f "$HOST_SCRIPT" ]; then
  echo "host script not found: $HOST_SCRIPT"
  exit 1
fi

mkdir -p "$HOST_DIR"
chmod +x "$HOST_SCRIPT"

cat > "$HOST_MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "ChromeMD native save host",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed native host manifest:"
echo "  $HOST_MANIFEST"
echo
echo "Extension ID:"
echo "  $EXTENSION_ID"
echo
echo "You can verify the host directly with:"
echo "  python3 \"$HOST_SCRIPT\""
