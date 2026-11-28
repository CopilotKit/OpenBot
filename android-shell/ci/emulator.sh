#!/usr/bin/env bash
# Creates and boots the CI emulator, then prepares it for the tests.
#
#   API_LEVEL (default 35), IMAGE_TAG (default google_apis), ARTIFACTS (default artifacts)
#
# google_apis (not playstore): adb root works, so Chrome's command-line flags can be written to
# skip its first-run screens; the image has Chrome and the Android System WebView.
# hw.keyboard=no and show_ime_with_hard_keyboard=1: the software keyboard shows, as on a phone.
set -euo pipefail

API_LEVEL="${API_LEVEL:-35}"
IMAGE_TAG="${IMAGE_TAG:-google_apis}"
ARTIFACTS="${ARTIFACTS:-artifacts}"
IMAGE="system-images;android-${API_LEVEL};${IMAGE_TAG};x86_64"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/emulator:$SDK/platform-tools:$PATH"
# Where avdmanager writes the AVD and the emulator looks for it (newer tools default elsewhere).
export ANDROID_AVD_HOME="$HOME/.android/avd"
mkdir -p "$ARTIFACTS" "$ANDROID_AVD_HOME"
# adb for the workflow's later steps too.
if [ -n "${GITHUB_PATH:-}" ]; then echo "$SDK/platform-tools" >> "$GITHUB_PATH"; fi

boot() {
  yes | sdkmanager --licenses > /dev/null 2>&1 || true
  sdkmanager --install "platform-tools" "emulator" "$IMAGE" > "$ARTIFACTS/sdkmanager.log" 2>&1 || {
    tail -n 30 "$ARTIFACTS/sdkmanager.log"; exit 1; }
  echo no | avdmanager create avd --force -n shell -k "$IMAGE" -d pixel_7 > /dev/null
  local config="$ANDROID_AVD_HOME/shell.avd/config.ini"
  [ -f "$config" ] || { echo "no AVD config at $config"; avdmanager list avd; exit 1; }
  set_config() {
    if grep -q "^$1=" "$config"; then sed -i "s|^$1=.*|$1=$2|" "$config"; else echo "$1=$2" >> "$config"; fi
  }
  set_config hw.keyboard no
  set_config hw.ramSize 4096
  set_config disk.dataPartition.size 8G
  set_config hw.gpu.enabled yes
  set_config hw.gpu.mode swiftshader_indirect
  set_config hw.camera.back none
  set_config hw.camera.front none
  set_config showDeviceFrame no
  nohup emulator -avd shell -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
    -camera-back none -camera-front none -netdelay none -netspeed full > "$ARTIFACTS/emulator.log" 2>&1 &
  adb wait-for-device
  local started=$SECONDS
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    if [ $((SECONDS - started)) -gt 600 ]; then echo "the emulator did not boot in 10 minutes"; tail -n 50 "$ARTIFACTS/emulator.log"; exit 1; fi
    sleep 3
  done
  echo "booted in $((SECONDS - started)) s"
}

prepare() {
  adb shell settings put global window_animation_scale 0
  adb shell settings put global transition_animation_scale 0
  adb shell settings put global animator_duration_scale "${ANIMATOR_SCALE:-0}"
  adb shell settings put secure show_ime_with_hard_keyboard 1
  adb shell settings put system screen_off_timeout 1800000
  adb shell svc power stayon true
  adb shell wm dismiss-keyguard || true
  adb shell input keyevent 82 || true
  # Chrome's first-run and default-browser screens: off through its command-line file (root).
  adb root > /dev/null 2>&1 || true
  sleep 3
  adb wait-for-device
  adb shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-signin-promo" > /data/local/chrome-command-line; chmod 644 /data/local/chrome-command-line; cp /data/local/chrome-command-line /data/local/tmp/chrome-command-line; chmod 644 /data/local/tmp/chrome-command-line' || true
  adb shell am set-debug-app --persistent com.android.chrome || true
  adb shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS > /dev/null 2>&1 || true
  # The test servers on the host, as localhost on the emulator (after adb root, which drops these).
  for port in 3010 3011 3012 8765 8766 8797; do adb reverse "tcp:$port" "tcp:$port" > /dev/null; done
  adb reverse --list
}

describe() {
  {
    echo "API_LEVEL=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
    echo "ANDROID_RELEASE=$(adb shell getprop ro.build.version.release | tr -d '\r')"
    echo "IMAGE=$IMAGE"
    echo "WEBVIEW=$(adb shell dumpsys webviewupdate | tr -d '\r' | grep -m1 'Current WebView package' | sed 's/^ *//')"
    echo "CHROME=$(adb shell dumpsys package com.android.chrome | tr -d '\r' | grep -m1 versionName | sed 's/^ *//')"
    echo "IME=$(adb shell settings get secure default_input_method | tr -d '\r')"
    echo "SCREEN=$(adb shell wm size | tr -d '\r' | tail -n1) $(adb shell wm density | tr -d '\r' | tail -n1)"
  } | tee "$ARTIFACTS/device.env"
  adb shell pm list packages | tr -d '\r' | grep -i -E 'chrome|webview|browser|inputmethod' || true
}

case "${1:-all}" in
  boot) boot ;;
  prepare) prepare ;;
  describe) describe ;;
  all) boot; prepare; describe ;;
esac
