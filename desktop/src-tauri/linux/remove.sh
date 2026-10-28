#!/bin/sh
# OpenBot Desktop's package removal on Linux: the .deb's postrm and the .rpm's %postun
# (bundle.linux.deb.postRemoveScript and bundle.linux.rpm.postRemoveScript in tauri.conf.json).
#
# Uninstalling takes away what Desktop left in each person's home for the browser it opened for them
# (src/local_browser.rs) and for the Recorder to find it (src/recorder_install.rs): the browser's data
# root, which holds the profile the person signed in to by hand, and the native messaging host
# manifest in each browser's folder, which would otherwise point the browsers at a program that is
# gone. A test reads this file against the paths the code writes, so the two cannot drift.
#
# Not on an upgrade: the new version is going on in its place and keeps them. dpkg calls this with
# "remove" or "purge" when the package goes, and rpm with 0.
#   https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html
#   https://rpm-software-management.github.io/rpm/manual/spec.html#scriptlets
#
# Each person's own files are removed as that person (runuser), never as root: a home is theirs to
# arrange, and root following a link one of them made could remove what is not theirs. Only the
# default locations are known here, since a person's XDG_DATA_HOME and XDG_CONFIG_HOME live in their
# own session. Nothing here may fail the removal itself.
case "$1" in
  remove | purge | 0) ;;
  *) exit 0 ;;
esac

getent passwd | while IFS=: read -r name _ uid _ _ home _; do
  case "$uid" in
    '' | *[!0-9]*) continue ;;
  esac
  # People, not system accounts: login.defs' UID_MIN on every distribution Desktop is built for.
  [ "$uid" -ge 1000 ] || continue
  [ "$uid" -lt 65534 ] || continue
  [ -d "$home" ] || continue
  runuser -u "$name" -- rm -rf -- \
    "$home/.local/share/openbot/local-computer" \
    "$home/.config/google-chrome/NativeMessagingHosts/ai.copilotkit.openbot.recorder.json" \
    "$home/.config/microsoft-edge/NativeMessagingHosts/ai.copilotkit.openbot.recorder.json" \
    "$home/.config/chromium/NativeMessagingHosts/ai.copilotkit.openbot.recorder.json" \
    </dev/null >/dev/null 2>&1 || true
done
exit 0
