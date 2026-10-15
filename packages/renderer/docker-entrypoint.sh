#!/bin/sh
# Container start-up: MapLibre Native draws through GLX, so it needs an X display.
# Start Xvfb, wait until it accepts connections, then hand over to the renderer.
# Xvfb's output (mostly keyboard-map warnings) goes to a file, printed only if it fails.
set -eu

display_number=99
socket="/tmp/.X11-unix/X${display_number}"
xvfb_log=/tmp/xvfb.log

Xvfb ":${display_number}" -screen 0 1280x1024x24 -nolisten tcp > "$xvfb_log" 2>&1 &
xvfb_pid=$!

fail() {
  echo "$1" >&2
  cat "$xvfb_log" >&2
  exit 1
}

i=0
until [ -S "$socket" ]; do
  kill -0 "$xvfb_pid" 2>/dev/null || fail "Xvfb exited before it was ready:"
  i=$((i + 1))
  [ "$i" -le 100 ] || fail "Xvfb was not ready after 10 seconds:"
  sleep 0.1
done

export DISPLAY=":${display_number}"
exec node packages/renderer/src/main.ts
