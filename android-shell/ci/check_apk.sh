#!/usr/bin/env bash
# What ships: fails when a debug-only hook or a test override is in the release APK's dex, or when
# the release manifest is debuggable or allows cleartext. Usage: check_apk.sh <release.apk> <releaseTest.apk>
set -euo pipefail
release="$1"
release_test="$2"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
analyzer="$SDK/cmdline-tools/latest/bin/apkanalyzer"

hooks='openbot\.(plain_webview|reset|test_session_cookie|stale_session|handoff_auto|force_offline|force_offline_seconds|force_dark|debug_tab_url)|debug-state'
overrides='openbot\.(base_url|diagnostics|test_name)'

dex_strings() { unzip -p "$1" 'classes*.dex' | strings -a; }

found="$(dex_strings "$release" | grep -E "$hooks|$overrides" || true)"
if [ -n "$found" ]; then
  echo "::error::debug-only hooks or test overrides are in the release APK's dex:"
  echo "$found"
  exit 1
fi
echo "release: no debug-only hook or test override names in the dex"

found="$(dex_strings "$release_test" | grep -E "$hooks" || true)"
if [ -n "$found" ]; then
  echo "::error::debug-only hooks are in the releaseTest APK's dex:"
  echo "$found"
  exit 1
fi
echo "releaseTest: no debug-only hook names in the dex (its test overrides: $(dex_strings "$release_test" | grep -cE "$overrides" || true) strings)"

if dex_strings "$release" | grep -q 'addJavascriptInterface'; then
  echo "::error::the release APK calls addJavascriptInterface"
  exit 1
fi

manifest="$("$analyzer" manifest print "$release")"
if echo "$manifest" | grep -q 'android:debuggable="true"'; then echo "::error::the release manifest is debuggable"; exit 1; fi
if echo "$manifest" | grep -q 'android:usesCleartextTraffic="true"'; then echo "::error::the release manifest allows cleartext"; exit 1; fi
echo "release manifest: not debuggable, no usesCleartextTraffic"
echo "$manifest" | grep -E 'targetSdkVersion|minSdkVersion|allowBackup|networkSecurityConfig|enableOnBackInvokedCallback|autoVerify|uses-permission' | sed 's/^ */  /'
echo "sizes: $(du -h "$release" | cut -f1) release, $(du -h "$release_test" | cut -f1) releaseTest"
