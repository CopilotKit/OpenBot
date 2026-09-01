#!/usr/bin/env bash
set -euo pipefail

entrypoint_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$entrypoint_dir"

# Standalone supervised computers start as root because a fresh Docker volume is root-owned. Hand
# the two durable directories to Chromium, then re-exec the entire desktop as the unprivileged user
# shipped by Playwright. The all-in-one image already invokes this script as pwuser and skips this.
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /profiles /workspace /tmp/.X11-unix /tmp/runtime-pwuser
  chown -R pwuser:pwuser /profiles /workspace
  chmod 1777 /tmp/.X11-unix
  chown pwuser:pwuser /tmp/runtime-pwuser
  chmod 700 /tmp/runtime-pwuser
  exec runuser -u pwuser --preserve-environment -- env \
    HOME=/home/pwuser \
    USER=pwuser \
    LOGNAME=pwuser \
    XDG_RUNTIME_DIR=/tmp/runtime-pwuser \
    "$0" "$@"
fi

export DISPLAY="${DISPLAY:-:99}"
export DESKTOP_WIDTH="${DESKTOP_WIDTH:-1280}"
export DESKTOP_HEIGHT="${DESKTOP_HEIGHT:-800}"
export COMPUTER_DESKTOP=on

Xvfb "$DISPLAY" \
  -screen 0 "${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24" \
  -nolisten tcp \
  -ac &
xvfb_pid=$!

for _attempt in $(seq 1 50); do
  if DISPLAY="$DISPLAY" xset q >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "The virtual display stopped before it became ready." >&2
    exit 1
  fi
  sleep 0.1
done

if ! DISPLAY="$DISPLAY" xset q >/dev/null 2>&1; then
  echo "The virtual display did not become ready." >&2
  exit 1
fi

openbox-session >/tmp/openbox.log 2>&1 &
tint2 >/tmp/tint2.log 2>&1 &

# One read-only server for passive watching and one writable server for a control lease. Both stay on
# loopback; the authenticated Bun API is the only route out of the computer.
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw -viewonly -noxdamage \
  >/tmp/x11vnc-view.log 2>&1 &
x11vnc -display "$DISPLAY" -rfbport 5901 -localhost -forever -shared -nopw -noxdamage \
  >/tmp/x11vnc-control.log 2>&1 &

websockify --heartbeat 30 127.0.0.1:6080 127.0.0.1:5900 \
  >/tmp/websockify-view.log 2>&1 &
websockify --heartbeat 30 127.0.0.1:6081 127.0.0.1:5901 \
  >/tmp/websockify-control.log 2>&1 &

exec bun src/index.ts
