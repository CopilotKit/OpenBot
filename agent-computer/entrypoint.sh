#!/usr/bin/env bash
set -euo pipefail

entrypoint_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$entrypoint_dir"

# Standalone supervised computers start as root because a fresh Docker volume is root-owned. Hand
# the two durable directories to Chromium, then re-exec the entire desktop as the unprivileged user
# shipped by Playwright. The all-in-one image already invokes this script as pwuser and skips this.
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /profiles /workspace /tmp/.X11-unix /tmp/runtime-pwuser
  pw_uid="$(id -u pwuser)"
  pw_gid="$(id -g pwuser)"
  for durable_dir in /profiles /workspace; do
    ownership_marker="$durable_dir/.openbot-owned-${pw_uid}-${pw_gid}"
    # A fresh volume is root-owned, but everything written after the handoff is already pwuser's.
    # Remember the one recursive migration so a resume does not walk every retained profile and
    # workspace file before the desktop can appear.
    if [ ! -e "$ownership_marker" ]; then
      chown -R pwuser:pwuser "$durable_dir"
      touch "$ownership_marker"
      chown pwuser:pwuser "$ownership_marker"
    else
      chown pwuser:pwuser "$durable_dir" "$ownership_marker"
    fi
  done
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
desktop_pids=("$xvfb_pid")

stop_desktop() {
  trap - TERM INT
  kill "${desktop_pids[@]}" 2>/dev/null || true
  wait "${desktop_pids[@]}" 2>/dev/null || true
}

# PID 1 has to pass container shutdown to every desktop process. Without this, stopping the service
# can leave Chromium or a VNC bridge alive until the runtime's hard kill deadline.
trap 'stop_desktop; exit 0' TERM INT

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

# A small, deliberate desktop rather than the distro's broken default launcher list. The stock
# Tint2 config names Firefox, Chromium and Tint2 settings desktop files which are not installed in
# this image, so closing the managed Chromium window leaves a panel full of shortcuts that do
# nothing. These two are the applications this computer actually provides to a person.
desktop_dir="$XDG_RUNTIME_DIR/openbot-desktop"
mkdir -p "$desktop_dir" "$HOME/.config/openbox"

cat >"$desktop_dir/openbot-browser" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bun -e '
  const token = process.env.COMPUTER_TOKEN ?? "";
  const port = process.env.PORT ?? "4100";
  const response = await fetch(`http://127.0.0.1:${port}/desktop/apps/browser`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`OpenBot could not open the managed browser (${response.status}): ${await response.text()}`);
  }
' >>/tmp/openbot-browser-launcher.log 2>&1
EOF

cat >"$desktop_dir/openbot-terminal" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
workspace_dir="${WORKSPACE_DIR:-/workspace}"
exec xterm \
  -T "Terminal - workspace" \
  -fa Monospace \
  -fs 12 \
  -geometry 100x32 \
  -e bash -lc 'cd "$1"; exec bash -l' -- "$workspace_dir"
EOF
chmod +x "$desktop_dir/openbot-browser" "$desktop_dir/openbot-terminal"

cat >"$desktop_dir/browser.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path fill="#ea4335" d="M32 4a28 28 0 0 1 24.2 14H31.7a14 14 0 0 0-12 6.8L12 11.7A27.9 27.9 0 0 1 32 4Z"/>
  <path fill="#fbbc04" d="M12 11.7 24.3 33A14 14 0 0 0 32 45.9L24.5 59A28 28 0 0 1 12 11.7Z"/>
  <path fill="#34a853" d="M24.5 59 36.8 37.7A14 14 0 0 0 45.7 33h15A28 28 0 0 1 24.5 59Z"/>
  <circle cx="32" cy="32" r="12" fill="#4285f4" stroke="#fff" stroke-width="3"/>
</svg>
EOF

cat >"$desktop_dir/terminal.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="5" y="8" width="54" height="48" rx="9" fill="#202124" stroke="#8ab4f8" stroke-width="3"/>
  <path d="m17 23 9 9-9 9" fill="none" stroke="#8ab4f8" stroke-linecap="round" stroke-linejoin="round" stroke-width="4"/>
  <path d="M32 42h15" stroke="#fff" stroke-linecap="round" stroke-width="4"/>
</svg>
EOF

cat >"$desktop_dir/browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Browser
Comment=Open or return to this Bot's managed browser
Exec=$desktop_dir/openbot-browser
Icon=$desktop_dir/browser.svg
Terminal=false
EOF

cat >"$desktop_dir/terminal.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Terminal
Comment=Open a terminal in the durable workspace
Exec=$desktop_dir/openbot-terminal
Icon=$desktop_dir/terminal.svg
Terminal=false
EOF

cat >"$desktop_dir/tint2rc" <<EOF
# OpenBot's two-app dock. No package-manager launchers and no dead distro defaults.
rounded = 14
border_width = 1
border_sides = TBLR
background_color = #202124 100
border_color = #5f6368 100
background_color_hover = #292a2d 100
border_color_hover = #8ab4f8 100
background_color_pressed = #303134 100
border_color_pressed = #8ab4f8 100

rounded = 6
border_width = 1
border_sides = TBLR
background_color = #202124 100
border_color = #5f6368 100
background_color_hover = #303134 100
border_color_hover = #8ab4f8 100
background_color_pressed = #303134 100
border_color_pressed = #8ab4f8 100

panel_items = L
panel_size = 148 56
panel_margin = 0 12
panel_padding = 10 6 10
panel_background_id = 1
panel_position = bottom center horizontal
panel_layer = top
panel_monitor = all
panel_shrink = 1
autohide = 0
strut_policy = none
wm_menu = 0
disable_transparency = 1
mouse_effects = 1

launcher_padding = 4 2 4
launcher_background_id = 0
launcher_icon_background_id = 0
launcher_icon_size = 38
launcher_icon_asb = 100 0 0
launcher_icon_theme_override = 0
startup_notifications = 0
launcher_tooltip = 1
launcher_item_app = $desktop_dir/browser.desktop
launcher_item_app = $desktop_dir/terminal.desktop

tooltip_show_timeout = 0.25
tooltip_hide_timeout = 0.1
tooltip_padding = 8 6
tooltip_background_id = 2
tooltip_font_color = #ffffff 100
EOF

cat >"$HOME/.config/openbox/menu.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="OpenBot">
    <item label="Browser"><action name="Execute"><command>$desktop_dir/openbot-browser</command></action></item>
    <item label="Terminal"><action name="Execute"><command>$desktop_dir/openbot-terminal</command></action></item>
  </menu>
</openbox_menu>
EOF

openbox-session >/tmp/openbox.log 2>&1 &
desktop_pids+=("$!")
# Openbox paints the root window while it starts, so the desktop color belongs after it rather than
# before it. A tiny readiness wait avoids a race that otherwise leaves the VM black on fast boots.
for _attempt in $(seq 1 50); do
  if obxprop --root 2>/dev/null | grep -q "^_NET_SUPPORTING_WM_CHECK"; then
    break
  fi
  sleep 0.1
done
xsetroot -solid "#d9dde3"
tint2 -c "$desktop_dir/tint2rc" >/tmp/tint2.log 2>&1 &
desktop_pids+=("$!")

# One read-only server for passive watching and one writable server for a control lease. Both stay on
# loopback; the authenticated Bun API is the only route out of the computer.
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw -viewonly -noxdamage \
  >/tmp/x11vnc-view.log 2>&1 &
desktop_pids+=("$!")
x11vnc -display "$DISPLAY" -rfbport 5901 -localhost -forever -shared -nopw -noxdamage \
  >/tmp/x11vnc-control.log 2>&1 &
desktop_pids+=("$!")

websockify --heartbeat 30 127.0.0.1:6080 127.0.0.1:5900 \
  >/tmp/websockify-view.log 2>&1 &
desktop_pids+=("$!")
websockify --heartbeat 30 127.0.0.1:6081 127.0.0.1:5901 \
  >/tmp/websockify-control.log 2>&1 &
desktop_pids+=("$!")

bun src/index.ts &
desktop_pids+=("$!")

# The desktop is one service. A dead framebuffer, window manager, VNC server, bridge, browser API,
# or display leaves a screen that looks healthy and never recovers, so fail the service and let its
# supervisor restart the complete set together.
set +e
wait -n -p stopped_pid "${desktop_pids[@]}"
stopped_status=$?
set -e
echo "Desktop process ${stopped_pid:-unknown} stopped unexpectedly (status ${stopped_status})." >&2
stop_desktop
exit 1
