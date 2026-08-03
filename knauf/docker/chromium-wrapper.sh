#!/bin/sh
export HOME=/tmp
CHROMIUM_BIN=/usr/bin/chromium-browser
if [ ! -x "$CHROMIUM_BIN" ]; then
  CHROMIUM_BIN=/usr/bin/chromium
fi
exec su-exec node "$CHROMIUM_BIN" "$@"
